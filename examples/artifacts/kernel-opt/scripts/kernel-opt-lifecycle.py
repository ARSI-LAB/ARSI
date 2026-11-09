#!/usr/bin/env python3
"""Process-local kernel lifecycle script for application.kernel-opt.

Application invokes a new local process for each command, sends one JSON
request on stdin and expects one JSON response on stdout. Write diagnostics to
stderr. The script runs on the machine with the NPU and build toolchain; no
remote deployment is involved.

Request: {"action", "experimentId", "instanceId", "parametersDigest",
          "parameters", "source"} where parameters is the candidate's
config.json and source is the candidate workspace directory holding the
kernel sources.
Response: {"status", "instanceId", "parametersDigest?", "resources?",
           "failure?"}. A stopped response needs only status and instanceId;
ready requires resources with queried identities, never invented values.
Safety-scan or build failures map to status "failed" with a failure detail
(message + log path); only confirmed device capacity exhaustion maps to
"capacity-rejected". A correctness-precheck rejection maps to "rejected":
the candidate workspace is staged and owned, but the candidate itself is
broken — the state marker stays "failed" and the evaluator records the
auditable failed measurement instead of the run crashing on a failed
acquire. Never report a silent success.

start flow: sync candidate -> build -> deterministic AST precheck
(scan_candidate from ngo_agent, defending every backend uniformly) ->
optional correctness precheck -> ready. status reconciles: uncertain state is
"failed", never "ready". stop removes the instance workdir and confirms
absence, and is safe to repeat.

Configuration via environment:
    RSI_NPU_STATE_ROOT  per-instance workdir/state root (default /tmp/rsi-npu-op)
    RSI_KERNEL_BUILD_CMD   build command run inside the synced workspace
                           (default: bash build.sh if present)
    RSI_NPU_OPEVAL      path to op_precision.py; when set, a correctness
                           precheck runs during start on the first declared
                           case. When unset the precheck is skipped and
                           correctness is enforced by the evaluator checksum
                           hard gate.
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
BUILD_CMD = os.environ.get("RSI_KERNEL_BUILD_CMD")
OPEVAL = os.environ.get("RSI_NPU_OPEVAL")


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
    instanceId: str


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
    """Digest the build artifacts so modelIdentity is a real build identity."""
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


def query_resources(workdir: str) -> Resources:
    """Query real device and software-stack identity; never invent values."""
    import socket

    host = socket.gethostname()
    devices: list[str] = []
    try:
        output = subprocess.run(
            ["npu-smi", "info"], capture_output=True, text=True, timeout=30, check=True
        ).stdout
        for line in output.splitlines():
            columns = [t for t in line.strip(" |\t").split() if t != "|"]
            if columns and columns[0].isdigit():
                devices.append(columns[0])
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError(f"cannot query NPU devices: {error}") from error
    if not devices:
        raise RuntimeError("npu-smi reported no NPU devices")
    software_parts = []
    probes = [
        [
            sys.executable,
            "-c",
            "import torch, torch_npu; print(torch.__version__, torch_npu.__version__)",
        ]
    ]
    install_infos = []
    home = os.environ.get("ASCEND_HOME_PATH")
    if home:
        install_infos.append(os.path.join(home, "ascend_toolkit_install.info"))
    install_infos.extend(
        sorted(
            glob_patterns("/usr/local/Ascend/cann-*/**/ascend_toolkit_install.info")
        )
    )
    if install_infos:
        probes.append(["cat", install_infos[-1]])
    for probe in probes:
        try:
            output = subprocess.run(
                probe, capture_output=True, text=True, timeout=60
            )
            if output.returncode == 0 and output.stdout.strip():
                software_parts.append(output.stdout.strip().splitlines()[0])
        except (OSError, subprocess.SubprocessError):
            pass
    if not software_parts:
        raise RuntimeError("cannot query CANN/torch_npu software versions")
    return Resources(
        verified=True,
        host=host,
        devices=sorted(set(devices)),
        modelIdentity=build_digest(workdir),
        software="; ".join(software_parts),
    )


def glob_patterns(pattern: str) -> list[str]:
    import glob

    return glob.glob(pattern, recursive=True)


def sync_candidate(request: LifecycleRequest, workdir: str) -> None:
    # Process-local: the whole candidate workspace (input.py, config.json,
    # cases.json, build.sh) is synced; the build procedure is part of it.
    shutil.copytree(request["source"], workdir, dirs_exist_ok=True)
    if not os.path.isfile(os.path.join(workdir, "input.py")):
        raise RuntimeError("candidate workspace is missing input.py")
    if not os.path.isfile(os.path.join(workdir, "config.json")):
        raise RuntimeError("candidate workspace is missing config.json")


def scan_kernels(workdir: str) -> None:
    """Deterministic AST allow-list scan of the kernel source (design: the
    scan lives at the precheck/build step, not in any single proposer)."""
    try:
        from ngo_agent.agents.kernel_agent import scan_candidate
    except ImportError as error:
        raise RuntimeError(
            "ngo_agent is required for the deterministic precheck scan; "
            "install the ngo-agent package on this machine"
        ) from error
    path = os.path.join(workdir, "input.py")
    with open(path, "r", encoding="utf-8") as handle:
        source = handle.read()
    violations = scan_candidate(source)
    if violations:
        raise RuntimeError(
            f"safety scan rejected input.py: {'; '.join(violations)}"
        )


def run_build(workdir: str) -> None:
    log_path = os.path.join(workdir, "build.log")
    command = BUILD_CMD
    if not command:
        if os.path.isfile(os.path.join(workdir, "build.sh")):
            command = "bash build.sh"
        else:
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
    """The candidate itself failed the correctness precheck (distinct from
    infrastructure failure: the workspace is valid, the candidate is not)."""


def run_precheck(request: LifecycleRequest, workdir: str) -> None:
    """Quick correctness gate during start so a fundamentally wrong candidate
    surfaces as instance failure instead of a wasted evaluation round."""
    if not OPEVAL:
        print("RSI_NPU_OPEVAL unset; skipping start precheck", file=sys.stderr)
        return
    cases = os.path.join(workdir, "cases.json")
    if not os.path.isfile(cases):
        print("no cases.json in the candidate workspace; skipping start precheck",
              file=sys.stderr)
        return
    proc = subprocess.run(
        [
            sys.executable, OPEVAL,
            "--instance", request["instanceId"],
            "--case", cases_first(cases),
            "--cases", cases,
            # The instance is built but not yet ready during start precheck.
            "--allow-starting",
            "--out", os.path.join(workdir, "precheck.json"),
        ],
        capture_output=True, text=True, timeout=600,
    )
    if proc.returncode != 0:
        raise _PrecheckRejected(
            f"precheck failed: {proc.stderr.strip()[:2000]}"
        )
    with open(os.path.join(workdir, "precheck.json"), "r", encoding="utf-8") as handle:
        result = json.load(handle)
    if not result.get("checksumMatch"):
        raise _PrecheckRejected(
            f"precheck checksum gate failed: {result.get('error')}"
        )


def cases_first(cases_path: str) -> str:
    with open(cases_path, "r", encoding="utf-8") as handle:
        case_set = json.load(handle)
    entries = case_set.get("cases") or []
    if not entries:
        raise RuntimeError("case set is empty")
    return str(entries[0]["id"])


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
        # Persist a real state marker only after the build succeeded; status
        # reconciles anything else as failed rather than guessing.
        write_state(workdir, {
            "status": "starting",
            "instanceId": instance_id,
            "experimentId": request["experimentId"],
            "parametersDigest": request["parametersDigest"],
            "workdir": workdir,
        })
        scan_kernels(workdir)
        try:
            run_precheck(request, workdir)
        except _PrecheckRejected as error:
            # Candidate rejection, not instance failure: keep the truthful
            # "failed" state marker (the evaluator's workspace resolution
            # depends on it) but answer "rejected" so the acquire succeeds
            # and the loop records a stale round instead of crashing.
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
        resources = query_resources(workdir)
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
        # Present workdir without a valid owned marker: uncertain, never ready.
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
        # Ready marker without verified resources cannot be trusted.
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
