#!/usr/bin/env python3
"""Mock process-local kernel lifecycle for the kernel-opt smoke run.

Same start/status/stop JSON stdin/stdout protocol and state machine as
kernel-opt-lifecycle.py, with the NPU-facing steps stubbed so the full
recipe chain (lifecycle -> evaluator -> selector -> memory) runs on a
machine without npu-smi, torch_npu or ngo_agent installed:

- resources carry a synthetic but shape-faithful identity (verified host,
  one device, digest of build artifacts, mock software stack);
- the correctness precheck is replaced by a deterministic poison marker:
  a candidate whose config.json sets BLOCK_SIZE to 256 is rejected exactly
  like a real precheck checksum failure (status "rejected", state marker
  "failed" with kind "precheck-rejected"), driving the evaluator's failed
  measurement and the policy's stale round;
- the build step still runs the candidate's build.sh (py_compile) so broken
  sources surface as instance failures, not silent successes.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
from enum import Enum
from typing import Literal, TypedDict

STATE_ROOT = os.environ.get("RSI_NPU_STATE_ROOT", "/tmp/rsi-npu-op")
# The tiling value the mock precheck rejects, mirroring a checksum mismatch.
POISON_BLOCK_SIZE = 256


class Action(str, Enum):
    START = "start"
    STATUS = "status"
    STOP = "stop"


class LifecycleRequest(TypedDict, total=False):
    action: Action
    experimentId: str
    instanceId: str
    parametersDigest: str
    parameters: dict
    source: str


class Resources(TypedDict):
    verified: Literal[True]
    host: str
    devices: list
    modelIdentity: str
    software: str


class ResponseDetails(TypedDict, total=False):
    parametersDigest: str
    resources: Resources
    failure: dict


class LifecycleResponse(ResponseDetails):
    status: Literal["stopped", "starting", "ready", "capacity-rejected", "rejected", "failed"]


def json_object(value: object, field: str) -> dict:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise TypeError(field + " must be a JSON object")
    return value


def text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TypeError(field + " must be a nonempty string")
    return value


def parse_request(value: object) -> LifecycleRequest:
    raw = json_object(value, "request")
    return LifecycleRequest(
        action=Action(text(raw.get("action"), "action")),
        experimentId=text(raw.get("experimentId"), "experimentId"),
        instanceId=text(raw.get("instanceId"), "instanceId"),
        parametersDigest=text(raw.get("parametersDigest"), "parametersDigest"),
        parameters=json_object(raw.get("parameters"), "parameters"),
        source=text(raw.get("source"), "source"),
    )


def workdir_of(instance_id: str) -> str:
    return os.path.join(STATE_ROOT, instance_id)


def read_state(workdir: str) -> dict | None:
    path = os.path.join(workdir, "state.json")
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def write_state(workdir: str, state: dict) -> None:
    os.makedirs(workdir, exist_ok=True)
    path = os.path.join(workdir, "state.json")
    pending = path + ".pending"
    with open(pending, "w", encoding="utf-8") as handle:
        json.dump(state, handle)
    os.replace(pending, path)


def failed(request: LifecycleRequest, message: str, log_path: str | None = None) -> LifecycleResponse:
    detail: dict = {"message": message}
    if log_path:
        detail["logPath"] = log_path
    response = LifecycleResponse(
        status="failed", instanceId=request["instanceId"],
        parametersDigest=request["parametersDigest"], failure=detail,
    )
    print(message, file=sys.stderr)
    if log_path:
        print("log: " + log_path, file=sys.stderr)
    return response


def file_digest(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_digest(workdir: str) -> str:
    artifacts = os.path.join(workdir, "build")
    if not os.path.isdir(artifacts):
        return "no-artifacts"
    digest = hashlib.sha256()
    for root, _, files in os.walk(artifacts):
        for name in sorted(files):
            path = os.path.join(root, name)
            digest.update(os.path.relpath(path, artifacts).encode())
            digest.update(file_digest(path).encode())
    return digest.hexdigest()


def mock_resources(workdir: str) -> Resources:
    # Synthetic identity with the same shape the evaluator/policy consumers
    # expect; a mock run never touches real device or software queries.
    return Resources(
        verified=True,
        host="mock-host",
        devices=["0"],
        modelIdentity=build_digest(workdir),
        software="mock-cann-8.2; mock-torch-npu-2.7",
    )


def sync_candidate(request: LifecycleRequest, workdir: str) -> None:
    shutil.copytree(request["source"], workdir, dirs_exist_ok=True)
    if not os.path.isfile(os.path.join(workdir, "input.py")):
        raise RuntimeError("candidate workspace is missing input.py")
    if not os.path.isfile(os.path.join(workdir, "config.json")):
        raise RuntimeError("candidate workspace is missing config.json")


def run_build(workdir: str) -> None:
    log_path = os.path.join(workdir, "build.log")
    command = os.environ.get("RSI_KERNEL_BUILD_CMD") or (
        "bash build.sh" if os.path.isfile(os.path.join(workdir, "build.sh")) else None
    )
    if not command:
        raise _BuildError(
            "no RSI_KERNEL_BUILD_CMD and no build.sh in the candidate workspace",
            None,
        )
    with open(log_path, "w", encoding="utf-8") as log:
        proc = subprocess.run(
            command, shell=True, cwd=workdir, stdout=log, stderr=subprocess.STDOUT
        )
    if proc.returncode != 0:
        raise _BuildError(f"build command failed with {proc.returncode}", log_path)


class _BuildError(RuntimeError):
    def __init__(self, message: str, log_path: str | None) -> None:
        super().__init__(message)
        self.log_path = log_path


class _PrecheckRejected(RuntimeError):
    """The candidate itself failed the mock correctness precheck."""


def run_precheck(request: LifecycleRequest, workdir: str) -> None:
    # Deterministic stand-in for op_precision.py: the poisoned BLOCK_SIZE
    # mirrors a checksum mismatch on the first declared case.
    if int(request["parameters"].get("BLOCK_SIZE", 0)) == POISON_BLOCK_SIZE:
        raise _PrecheckRejected(
            "precheck checksum gate failed: mock poison tiling "
            f"(BLOCK_SIZE={POISON_BLOCK_SIZE})"
        )


def start(request: LifecycleRequest) -> LifecycleResponse:
    instance_id = request["instanceId"]
    workdir = workdir_of(instance_id)
    existing = read_state(workdir)
    if existing and existing.get("parametersDigest") != request["parametersDigest"]:
        return failed(
            request,
            f"instance {instance_id} already holds different candidate parameters",
        )
    try:
        os.makedirs(workdir, exist_ok=True)
        sync_candidate(request, workdir)
        run_build(workdir)
        write_state(workdir, {
            "status": "starting",
            "instanceId": instance_id,
            "experimentId": request["experimentId"],
            "parametersDigest": request["parametersDigest"],
            "workdir": workdir,
        })
        try:
            run_precheck(request, workdir)
        except _PrecheckRejected as error:
            # Candidate rejection, not instance failure: keep the truthful
            # "failed" state marker but answer "rejected" so the acquire
            # succeeds and the evaluator records a failed measurement.
            write_state(workdir, {
                "status": "failed",
                "instanceId": instance_id,
                "experimentId": request["experimentId"],
                "parametersDigest": request["parametersDigest"],
                "workdir": workdir,
                "failure": {"kind": "precheck-rejected", "message": str(error)},
            })
            print(str(error), file=sys.stderr)
            return LifecycleResponse(
                status="rejected", instanceId=instance_id,
                parametersDigest=request["parametersDigest"],
                failure={"message": str(error)},
            )
        resources = mock_resources(workdir)
        write_state(workdir, {
            "status": "ready",
            "instanceId": instance_id,
            "experimentId": request["experimentId"],
            "parametersDigest": request["parametersDigest"],
            "workdir": workdir,
            "resources": dict(resources),
        })
        return LifecycleResponse(
            status="ready", instanceId=instance_id,
            parametersDigest=request["parametersDigest"],
            resources=resources,
        )
    except _BuildError as error:
        return failed(request, str(error), error.log_path)
    except RuntimeError as error:
        message = str(error)
        if "out of memory" in message.lower() or "capacity" in message.lower():
            return LifecycleResponse(
                status="capacity-rejected", instanceId=instance_id,
                parametersDigest=request["parametersDigest"],
                failure={"message": message},
            )
        return failed(request, message)


def status(request: LifecycleRequest) -> LifecycleResponse:
    workdir = workdir_of(request["instanceId"])
    if not os.path.isdir(workdir):
        return LifecycleResponse(
            status="stopped", instanceId=request["instanceId"]
        )
    state = read_state(workdir)
    if state is None or state.get("instanceId") != request["instanceId"]:
        return failed(request, "instance workdir exists without owned state")
    if state.get("parametersDigest") != request["parametersDigest"]:
        return failed(request, "instance workdir holds different parameters")
    if state.get("status") == "ready":
        saved = state.get("resources")
        if isinstance(saved, dict) and saved.get("verified") is True:
            return LifecycleResponse(
                status="ready", instanceId=request["instanceId"],
                parametersDigest=request["parametersDigest"],
                resources=Resources(
                    verified=True,
                    host=str(saved["host"]),
                    devices=list(saved["devices"]),
                    modelIdentity=str(saved["modelIdentity"]),
                    software=str(saved["software"]),
                ),
            )
        return failed(request, "ready state lacks verified resources")
    if state.get("status") == "starting":
        return LifecycleResponse(
            status="starting", instanceId=request["instanceId"],
            parametersDigest=request["parametersDigest"],
        )
    if state.get("status") == "failed":
        failure = state.get("failure")
        if (
            isinstance(failure, dict)
            and failure.get("kind") == "precheck-rejected"
        ):
            return LifecycleResponse(
                status="rejected", instanceId=request["instanceId"],
                parametersDigest=request["parametersDigest"],
                failure={
                    "message": str(
                        failure.get("message", "candidate rejected by precheck")
                    )
                },
            )
    return failed(request, f"instance state is {state.get('status')!r}")


def stop(request: LifecycleRequest) -> LifecycleResponse:
    workdir = workdir_of(request["instanceId"])
    shutil.rmtree(workdir, ignore_errors=True)
    if os.path.isdir(workdir):
        return LifecycleResponse(
            status="failed", instanceId=request["instanceId"],
            failure={"message": "workdir cleanup did not complete"},
        )
    return LifecycleResponse(status="stopped", instanceId=request["instanceId"])


def main() -> None:
    request = parse_request(json.load(sys.stdin))
    handlers = {Action.START: start, Action.STATUS: status, Action.STOP: stop}
    response = handlers[request["action"]](request)
    print(json.dumps(response))


if __name__ == "__main__":
    main()
