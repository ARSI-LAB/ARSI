#!/usr/bin/env python3
"""Own a single-node, loopback vLLM-Ascend service using the RSI remote protocol."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener


PROC = Path("/proc")
LOOPBACK = "127.0.0.1"


class CandidateError(ValueError):
    """A rejected candidate never reaches the deployment command."""


PERFORMANCE_GROUPS = {
    "SchedulerConfig", "CacheConfig", "AttentionConfig", "MambaConfig",
    "CompilationConfig", "SpeculativeConfig", "OffloadConfig",
}
# These options live outside the same argument groups across vLLM releases.
PERFORMANCE_OPTIONS = {
    "enforce_eager", "attention_backend", "compilation_config", "speculative_config",
    "additional_config", "disable_custom_all_reduce", "enable_expert_parallel", "all2all_backend",
}
JSON_OPTIONS = {"compilation_config", "speculative_config", "additional_config"}
FIXED_OPTIONS = {
    "port", "host", "model", "model_tag", "served_model_name", "dtype", "max_model_len",
    "tensor_parallel_size", "data_parallel_size", "pipeline_parallel_size", "quantization",
    "config", "api_key", "trust_remote_code", "scheduler_cls",
}
CODE_OR_PATH_SUFFIXES = ("_path", "_module", "_class", "_cls", "_plugin")
FIXED_JSON_KEYS = FIXED_OPTIONS | {
    "backend", "custom_ops", "custom_passes", "pass_config", "model_revision",
    "draft_tensor_parallel_size", "tokenizer", "plugin", "path",
    "rejection_sample_method", "synthetic_acceptance_rates", "synthetic_acceptance_length",
}


def parameter_catalog(parser):
    catalog = {}
    for group in parser._action_groups:
        for action in group._group_actions:
            name = action.dest
            flag = "--" + name.replace("_", "-")
            if (
                name in FIXED_OPTIONS or name.endswith(CODE_OR_PATH_SUFFIXES)
                or flag not in action.option_strings
                or action.help == argparse.SUPPRESS
                or (group.title not in PERFORMANCE_GROUPS and name not in PERFORMANCE_OPTIONS)
            ):
                continue
            option = {"flag": flag, "group": group.title, "description": str(action.help or "")}
            if isinstance(action, argparse.BooleanOptionalAction):
                option.update(kind="boolean", falseFlag="--no-" + flag[2:])
            elif isinstance(action, argparse._StoreTrueAction):
                option.update(kind="boolean")
            elif isinstance(action, argparse._StoreFalseAction):
                option.update(kind="boolean", falseFlag=flag)
                del option["flag"]
            elif action.nargs == 0:
                continue
            elif name in JSON_OPTIONS:
                option.update(kind="object")
            else:
                kind = {int: "integer", float: "number", str: "string"}.get(action.type, "scalar")
                option.update(kind=kind)
                if action.nargs not in (None, "?"):
                    option["items"] = action.nargs
                if action.choices and all(type(value) in (str, int, float) for value in action.choices):
                    option["choices"] = list(action.choices)
            catalog[name] = option
    return catalog


def installed_catalog():
    python = os.environ.get("VLLM_ASCEND_PYTHON", sys.executable)
    result = subprocess.run(
        [python, __file__, "--parameter-catalog"],
        capture_output=True, text=True, timeout=45, check=True,
    )
    return json.loads(result.stdout.splitlines()[-1])


def check_json_options(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key in FIXED_JSON_KEYS or key.endswith(CODE_OR_PATH_SUFFIXES):
                raise CandidateError(f"Structured framework parameter cannot change {key}")
            check_json_options(item)
    elif isinstance(value, list):
        for item in value:
            check_json_options(item)


def encode_parameter(name, value, option):
    kind = option["kind"]
    valid = {
        "integer": type(value) is int,
        "number": type(value) in (int, float),
        "string": isinstance(value, str),
        "scalar": type(value) in (str, int, float),
    }
    if not valid[kind] or ("choices" in option and value not in option["choices"]):
        raise CandidateError(f"{name} has an invalid value for the installed vLLM option")
    return str(value)


def tuning_flags(parameters, catalog):
    if not isinstance(parameters, dict) or not parameters:
        raise CandidateError("tuning.json must be a nonempty JSON object")
    flags = []
    for name, value in sorted(parameters.items()):
        option = catalog.get(name)
        if option is None:
            raise CandidateError(f"Unsupported framework parameter for the installed vLLM: {name}")
        kind = option["kind"]
        if kind == "boolean":
            if type(value) is not bool:
                raise CandidateError(f"{name} must be a boolean")
            flag = option.get("flag" if value else "falseFlag")
            if flag:
                flags.append(flag)
        elif kind == "object":
            if not isinstance(value, dict):
                raise CandidateError(f"{name} must be a JSON object")
            check_json_options(value)
            flags.append(option["flag"] + "=" + json.dumps(value, separators=(",", ":"), allow_nan=False))
        elif "items" in option:
            if not isinstance(value, list) or not value:
                raise CandidateError(f"{name} must be a nonempty array")
            count = option["items"]
            if isinstance(count, int) and len(value) != count:
                raise CandidateError(f"{name} must contain {count} values")
            items = [encode_parameter(name, item, option) for item in value]
            if any(isinstance(item, str) and item.startswith("-") for item in value):
                raise CandidateError(f"{name} values cannot be command-line options")
            flags.extend((option["flag"], *items))
        else:
            flags.append(option["flag"] + "=" + encode_parameter(name, value, option))
    return flags


def text_field(raw, key):
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a nonempty string")
    return value


def port_for(request):
    endpoint = request.get("endpoint")
    if not isinstance(endpoint, dict):
        raise ValueError("endpoint must be an object")
    origin = urlsplit(text_field(endpoint, "origin"))
    if (
        origin.scheme != "http"
        or origin.hostname != LOOPBACK
        or origin.username is not None
        or origin.password is not None
        or origin.path
        or origin.query
        or origin.fragment
        or not origin.port
    ):
        raise ValueError("endpoint.origin must be http://127.0.0.1:<port>")
    return origin.port


def model_fingerprint(path):
    config = path / "config.json"
    digest = hashlib.sha256(config.read_bytes())
    for index in sorted(path.glob("*.index.json")):
        digest.update(index.read_bytes())
    weights = sorted([*path.glob("*.safetensors"), *path.glob("*.bin")])
    if not weights:
        raise ValueError("the local model directory has no weight files")
    for file in weights:
        info = file.stat()
        digest.update(json.dumps([file.name, info.st_size, info.st_mtime_ns]).encode())
    return digest.hexdigest()


def deployment(request, port, flags):
    python = Path(os.environ.get("VLLM_ASCEND_PYTHON", sys.executable))
    model = Path(os.environ["VLLM_ASCEND_MODEL_PATH"])
    if not python.is_absolute() or not model.is_absolute():
        raise ValueError("VLLM_ASCEND_PYTHON and VLLM_ASCEND_MODEL_PATH must be absolute")
    visible = os.environ["ASCEND_RT_VISIBLE_DEVICES"].split(",")
    if len(set(visible)) != len(visible) or any(not re.fullmatch(r"[0-9]+", x) for x in visible):
        raise ValueError("ASCEND_RT_VISIBLE_DEVICES must list unique logical NPU IDs")
    parallel = int(os.environ.get("VLLM_ASCEND_TENSOR_PARALLEL_SIZE", len(visible)))
    max_length = int(os.environ.get("VLLM_ASCEND_MAX_MODEL_LEN", "4096"))
    if parallel != len(visible) or max_length < 1:
        raise ValueError("tensor parallel size must match visible NPUs and model length must be positive")
    utilization = request.get("memoryUtilization")
    if type(utilization) not in (int, float) or not 0 < utilization <= 1:
        raise ValueError("memoryUtilization must be in (0, 1]")
    fingerprint = model_fingerprint(model)
    probe = (
        "import json, importlib.metadata as metadata, torch, torch_npu\n"
        "devices = [torch.npu.get_device_name(i) for i in range(torch.npu.device_count())]\n"
        "versions = {name: metadata.version(name) for name in ('vllm', 'vllm-ascend', 'torch-npu')}\n"
        "print(json.dumps({'devices': devices, 'versions': versions}))"
    )
    result = subprocess.run(
        [str(python), "-c", probe], capture_output=True, text=True, timeout=45, check=True
    )
    identity = json.loads(result.stdout.splitlines()[-1])
    if len(identity["devices"]) != len(visible) or any(not name for name in identity["devices"]):
        raise ValueError("the Ascend runtime cannot verify all configured NPUs")
    resources = {
        "verified": True,
        "host": socket.gethostname(),
        "devices": [f"{device}:{name}" for device, name in zip(visible, identity["devices"])],
        "modelIdentity": fingerprint,
        "software": json.dumps({
            "packages": identity["versions"], "maxModelLen": max_length,
        }, sort_keys=True),
    }
    argv = [
        str(python), "-m", "vllm.entrypoints.cli.main", "serve", str(model),
        "--served-model-name", text_field(request["endpoint"], "model"),
        "--host", LOOPBACK, "--port", str(port),
        "--tensor-parallel-size", str(parallel), "--max-model-len", str(max_length),
        *flags,
    ]
    if "gpu_memory_utilization" not in request["parameters"]:
        argv.extend(("--gpu-memory-utilization", str(utilization)))
    return argv, resources


def read_json(path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None


def write_json(path, value):
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w") as file:
        json.dump(value, file)
        file.flush()
        os.fsync(file.fileno())
    temporary.replace(path)


def boot_id():
    return (PROC / "sys/kernel/random/boot_id").read_text().strip()


def proc_stat(pid):
    try:
        stat = (PROC / str(pid) / "stat").read_text()
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        return None
    fields = stat.rsplit(")", 1)[1].split()
    return (fields[0], int(fields[2]), int(fields[3]), int(fields[19]))


def group_members(leader):
    result = []
    for entry in PROC.iterdir():
        if not entry.name.isdecimal():
            continue
        pid = int(entry.name)
        status = proc_stat(pid)
        if status and status[0] != "Z" and status[1:3] == (leader, leader):
            result.append(pid)
    return result


def owned_group(owner):
    if owner["bootId"] != boot_id():
        return []
    pid = owner["pid"]
    leader = proc_stat(pid)
    members = group_members(pid)
    if members and (leader is None or leader[1:] != (pid, pid, owner["startTicks"])):
        raise ValueError("cannot verify ownership of the remaining process group")
    return members


def listening(members, port):
    address = f"0100007F:{port:04X}"
    sockets = set()
    for row in (PROC / "net/tcp").read_text().splitlines()[1:]:
        fields = row.split()
        if fields[1] == address and fields[3] == "0A":
            sockets.add(f"socket:[{fields[9]}]")
    if not sockets:
        return False
    for pid in members:
        try:
            for fd in (PROC / str(pid) / "fd").iterdir():
                try:
                    if os.readlink(fd) in sockets:
                        return True
                except (FileNotFoundError, ProcessLookupError):
                    continue
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    return False


def healthy(port):
    try:
        with build_opener(ProxyHandler({})).open(f"http://{LOOPBACK}:{port}/health", timeout=1) as response:
            return response.status == 200
    except (OSError, URLError):
        return False


def startup_reason(log):
    try:
        with log.open("rb") as file:
            file.seek(max(0, log.stat().st_size - 32768))
            tail = file.read(32768).lower()
    except FileNotFoundError:
        tail = b""
    if b"out of memory" in tail or b"no available memory" in tail or b"insufficient memory" in tail:
        return "vLLM reported memory pressure during startup"
    if b"unrecognized arguments" in tail or b"invalid choice" in tail:
        return "The installed vLLM rejected a command-line option"
    if re.search(rb"(?:max_num_batched_tokens|max_num_seqs)[^\n]*(?:must be|cannot be)", tail):
        return "vLLM rejected the batching configuration during startup"
    return "The owned vLLM process exited before readiness. Inspect the local launch log."


def stop(owner):
    for signum, seconds in ((signal.SIGTERM, 12), (signal.SIGKILL, 5)):
        if not owned_group(owner):
            return
        try:
            os.killpg(owner["pid"], signum)
        except ProcessLookupError:
            continue
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if not owned_group(owner):
                return
            time.sleep(0.1)
    if owned_group(owner):
        raise ValueError("owned vLLM process group did not stop")


def launch(directory, owner, argv):
    timeout = int(os.environ.get("VLLM_ASCEND_STARTUP_TIMEOUT_SECONDS", "540"))
    if not 0 < timeout <= 86400:
        raise ValueError("VLLM_ASCEND_STARTUP_TIMEOUT_SECONDS must be between 1 and 86400")
    # The worker waits for the command to publish its PID and start time before
    # it is allowed to launch vLLM. A cancelled command cannot orphan a service.
    worker_argv = [sys.executable, __file__, "--worker", str(directory), owner["instanceId"], *argv]
    file_actions = [
        (os.POSIX_SPAWN_OPEN, fd, os.devnull, os.O_RDONLY if fd == 0 else os.O_WRONLY, 0)
        for fd in (0, 1, 2)
    ]
    pid = os.posix_spawn(
        sys.executable, worker_argv, os.environ, file_actions=file_actions, setsid=True,
    )
    identity = proc_stat(pid)
    if identity is None or identity[1:3] != (pid, pid):
        raise ValueError("could not establish vLLM launcher process identity")
    write_json(directory / "owner.json", {
        **owner, "pid": pid, "startTicks": identity[3], "bootId": boot_id(),
        "startupDeadline": time.monotonic() + timeout,
    })


def worker(directory, instance_id, argv):
    # Remain the group leader until descendants exit. Stop signals the whole
    # group, while a stuck descendant can be retired by the caller's deadline.
    signal.signal(signal.SIGTERM, lambda *_: None)
    with (directory / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        owner = read_json(directory / "owner.json")
        if not owner or owner["instanceId"] != instance_id or owner["pid"] != os.getpid():
            return
        log = (directory / f"{instance_id}.log").open("wb")
        try:
            child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        finally:
            log.close()
    child.wait()
    write_json(directory / f"{instance_id}.exit.json", {"exitCode": child.returncode})
    while any(pid != os.getpid() for pid in group_members(os.getpid())):
        time.sleep(0.1)


def handle(request, root):
    action = text_field(request, "action")
    if action == "describe-parameters":
        return {"parameters": installed_catalog()}
    if action not in ("start", "status", "stop"):
        raise ValueError("unknown lifecycle action")
    identity = {key: text_field(request, key) for key in ("instanceId", "experimentId", "parametersDigest")}
    instance_id = identity["instanceId"]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", instance_id):
        raise ValueError("invalid instanceId")
    port = port_for(request)
    directory = root / str(port)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    owner_file = directory / "owner.json"
    exit_file = directory / f"{instance_id}.exit.json"
    stopped = {"status": "stopped", "instanceId": instance_id}
    with (directory / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        owner = read_json(owner_file)
        if owner and any(owner.get(key) != value for key, value in identity.items()):
            raise ValueError("vLLM launcher ownership does not match the request")
        if action == "stop":
            if owner:
                stop(owner)
                owner_file.unlink()
            return stopped
        if not owner:
            if action == "status":
                return stopped
            try:
                flags = tuning_flags(request.get("parameters"), installed_catalog())
            except CandidateError as error:
                return {**identity, "status": "startup-failed", "reason": str(error)}
            with socket.socket() as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind((LOOPBACK, port))
            argv, resources = deployment(request, port, flags)
            exit_file.unlink(missing_ok=True)
            launch(directory, {**identity, "resources": resources}, argv)
            return {**identity, "status": "starting"}
        members = owned_group(owner)
        if not members or exit_file.exists():
            return {**identity, "status": "startup-failed", "reason": startup_reason(directory / f"{instance_id}.log")}
        if listening(members, port) and healthy(port):
            if not owner.get("ready"):
                write_json(owner_file, {**owner, "ready": True})
            return {**identity, "status": "ready", "resources": owner["resources"]}
        if not owner.get("ready") and time.monotonic() >= owner["startupDeadline"]:
            return {**identity, "status": "startup-failed", "reason": "The owned vLLM process exceeded its readiness deadline"}
        return {**identity, "status": "starting"}


def main():
    os.umask(0o077)
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        worker(Path(sys.argv[2]), sys.argv[3], sys.argv[4:])
        return
    if len(sys.argv) == 2 and sys.argv[1] == "--parameter-catalog":
        from vllm.entrypoints.cli.serve import FlexibleArgumentParser, ServeSubcommand

        parser = FlexibleArgumentParser()
        serve = ServeSubcommand().subparser_init(parser.add_subparsers())
        print(json.dumps(parameter_catalog(serve), sort_keys=True))
        return
    if sys.platform != "linux":
        raise SystemExit("vLLM-Ascend launcher requires Linux")
    default_root = Path.cwd() / ".rsi/vllm-ascend"
    root = Path(os.environ.get("VLLM_ASCEND_STATE_DIR", default_root)).resolve()
    print(json.dumps(handle(json.load(sys.stdin), root)))


if __name__ == "__main__":
    main()
