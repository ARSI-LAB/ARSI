#!/usr/bin/env python3
"""Bridge the RSI launcher protocol to a provisioned server and owned SSH tunnel."""

import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import socket
import stat
import subprocess
import sys
import time
from urllib.parse import urlsplit
import uuid


# Requests and credentials travel over stdin, never in SSH's command line.
# The per-port gate prevents a delayed start from escaping an earlier stop. A
# new generation permits calibration to reuse an instance ID after cleanup.
REMOTE_BOOTSTRAP = r'''
import contextlib, fcntl, hashlib, io, json, os, pathlib, re, runpy, stat, sys, uuid
r = json.load(sys.stdin)
launcher = pathlib.Path(r["launcher"])
if hashlib.sha256(launcher.read_bytes()).hexdigest() != r["sha256"]:
    raise ValueError("remote launcher checksum mismatch")
request = r["request"]
env = {**os.environ, **r["env"]}
def invoke():
    os.environ.update(env)
    sys.argv = [str(launcher)]
    sys.stdin = io.StringIO(json.dumps(request))
    output = io.StringIO()
    # Keep the gate in the same process as start/stop even if SSH disconnects.
    # The lock FD is non-inheritable, so detached launcher workers cannot hold it.
    with contextlib.redirect_stdout(output):
        runpy.run_path(str(launcher), run_name="__main__")
    value = output.getvalue()
    if len(value.encode()) > 1048576:
        raise ValueError("remote launcher response exceeds 1 MiB")
    response = json.loads(value)
    if not isinstance(response, dict):
        raise ValueError("remote launcher response must be an object")
    if request["action"] != "describe-parameters":
        if response.get("instanceId") != request["instanceId"]:
            raise ValueError("remote launcher ownership mismatch")
        if response.get("status") != "stopped" and response.get("parametersDigest") != request["parametersDigest"]:
            raise ValueError("remote launcher parameter identity mismatch")
    return response
def save(path, value):
    temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex)
    with temporary.open("x") as output:
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)
def read(path):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor) as source:
        return json.load(source)
os.umask(0o077)
if request["action"] == "describe-parameters":
    print(json.dumps(invoke()))
else:
    generation = r["generation"]
    if not re.fullmatch(r"[a-f0-9]{32}", generation):
        raise ValueError("invalid bridge generation")
    bridge = pathlib.Path(env["VLLM_ASCEND_STATE_DIR"]) / ".ssh-bridge"
    directory = bridge / str(r["port"])
    for path in (bridge, directory):
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("remote bridge state must be private and owned by the current user")
    identity = {key: request[key] for key in ("instanceId", "experimentId", "parametersDigest")}
    identity.update(generation=generation, configDigest=r["configDigest"])
    current = directory / "current.json"
    stopped = directory / (generation + ".stopped")
    descriptor = os.open(directory / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        owner = read(current)
        action = request["action"]
        if action == "stop":
            if not stopped.exists():
                save(stopped, identity)
        if owner is not None and owner != identity:
            raise ValueError("remote bridge generation or ownership mismatch")
        if action == "start":
            if stopped.exists():
                raise ValueError("remote bridge generation has already been stopped")
            if owner is None:
                save(current, identity)
        response = invoke()
        if action == "stop" and response.get("status") == "stopped":
            current.unlink(missing_ok=True)
        print(json.dumps(response))
'''

FORWARDED_ENV = (
    "VLLM_ASCEND_MODEL_PATH", "ASCEND_RT_VISIBLE_DEVICES", "VLLM_ASCEND_STATE_DIR",
    "VLLM_API_KEY", "VLLM_ASCEND_TENSOR_PARALLEL_SIZE", "VLLM_ASCEND_MAX_MODEL_LEN",
    "VLLM_ASCEND_STARTUP_TIMEOUT_SECONDS",
)


class BridgeError(ValueError):
    """An operation failed without establishing the requested lifecycle outcome."""


def required(name):
    value = os.environ.get(name, "")
    if not value or "\0" in value:
        raise BridgeError(f"{name} must be set")
    return value


def absolute_path(value, name):
    if (
        not value.startswith("/") or value == "/" or "\\" in value
        or any(part in ("", ".", "..") for part in value.split("/")[1:])
        or any(ord(char) < 32 for char in value)
    ):
        raise BridgeError(f"{name} must be an absolute path without traversal")
    return value


def configuration():
    host, user = required("VLLM_SSH_HOST"), required("VLLM_SSH_USER")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", host):
        raise BridgeError("VLLM_SSH_HOST must be a hostname or address")
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]*", user):
        raise BridgeError("VLLM_SSH_USER must be an SSH username")
    try:
        port = int(os.environ.get("VLLM_SSH_PORT", "22"))
    except ValueError:
        raise BridgeError("VLLM_SSH_PORT must be an integer") from None
    if not 1 <= port <= 65535:
        raise BridgeError("VLLM_SSH_PORT must be in 1..65535")
    python = absolute_path(required("VLLM_SSH_REMOTE_PYTHON"), "VLLM_SSH_REMOTE_PYTHON")
    launcher = absolute_path(required("VLLM_SSH_REMOTE_LAUNCHER"), "VLLM_SSH_REMOTE_LAUNCHER")
    checksum = required("VLLM_SSH_REMOTE_LAUNCHER_SHA256")
    if not re.fullmatch(r"[a-f0-9]{64}", checksum):
        raise BridgeError("VLLM_SSH_REMOTE_LAUNCHER_SHA256 must be a lowercase SHA-256 digest")
    env = {name: os.environ[name] for name in FORWARDED_ENV if name in os.environ}
    for name in FORWARDED_ENV[:4]:
        required(name)
    for name in ("VLLM_ASCEND_MODEL_PATH", "VLLM_ASCEND_STATE_DIR"):
        absolute_path(env[name], name)
    env["VLLM_ASCEND_PYTHON"] = python
    identity_file = os.environ.get("VLLM_SSH_IDENTITY_FILE")
    if identity_file is not None:
        absolute_path(identity_file, "VLLM_SSH_IDENTITY_FILE")
    root = Path(os.environ.get("VLLM_SSH_STATE_DIR", str(Path.cwd() / ".rsi/vllm-ssh")))
    absolute_path(str(root), "VLLM_SSH_STATE_DIR")
    config = {
        "host": host, "user": user, "port": port, "identityFile": identity_file,
        "python": python, "launcher": launcher, "sha256": checksum, "env": env,
    }
    config["digest"] = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    config["root"] = root
    return config


def ssh_arguments(config):
    # Ignore ambient forwarding/ControlMaster settings; only this wrapper owns
    # the tunnel. The standard known_hosts files and identities remain usable.
    return [
        "ssh", "-F", os.devnull, "-T", "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15",
        "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2",
        "-p", str(config["port"]),
        *(["-i", config["identityFile"]] if config["identityFile"] else []),
    ]


def destination(config):
    return config["user"] + "@" + config["host"]


def run_ssh(args, payload=None, timeout=90):
    try:
        result = subprocess.run(
            args, input=None if payload is None else json.dumps(payload), text=True,
            stdin=subprocess.DEVNULL if payload is None else None,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise BridgeError("SSH command failed or timed out; reconcile ownership before retrying") from None
    if len(result.stdout.encode()) > 1024 * 1024:
        raise BridgeError("SSH response exceeds 1 MiB; reconcile ownership before retrying")
    return result


def remote_call(config, request, generation=None, port=None):
    command = shlex.quote(config["python"]) + " -c " + shlex.quote(REMOTE_BOOTSTRAP)
    result = run_ssh(
        [*ssh_arguments(config), "-S", "none", "-o", "ControlMaster=no", destination(config), command],
        {"launcher": config["launcher"], "sha256": config["sha256"], "env": config["env"],
         "request": request, "generation": generation, "port": port, "configDigest": config["digest"]},
    )
    if result.returncode:
        raise BridgeError("Remote lifecycle command failed; check SSH, launcher checksum and remote ownership")
    try:
        response = json.loads(result.stdout)
    except ValueError:
        raise BridgeError("Remote launcher returned invalid JSON") from None
    if not isinstance(response, dict):
        raise BridgeError("Remote launcher response must be an object")
    return response


def private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise BridgeError("SSH bridge state directory must be private and owned by the current user")


def read_owner(path):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor) as file:
        value = json.load(file)
    if not isinstance(value, dict):
        raise BridgeError("Invalid SSH bridge owner record")
    return value


def write_owner(path, value):
    temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex)
    try:
        with temporary.open("x") as file:
            json.dump(value, file)
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def control(config, directory, action):
    return run_ssh(
        [*ssh_arguments(config), "-S", str(directory / "m"), "-O", action, destination(config)],
        timeout=20,
    ).returncode == 0


def port_available(port):
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def retire_stale_socket(path, port):
    before = path.lstat()
    if not stat.S_ISSOCK(before.st_mode):
        raise BridgeError("Owned SSH control path is not a socket")
    with socket.socket(socket.AF_UNIX) as probe:
        probe.settimeout(1)
        try:
            probe.connect(str(path))
        except OSError as error:
            if error.errno not in (errno.ECONNREFUSED, errno.ENOENT):
                raise BridgeError("Owned SSH control socket state is unknown") from None
        else:
            raise BridgeError("Owned SSH control socket is live but control failed; state was retained")
    if not port_available(port):
        raise BridgeError("Local inference port is occupied; stale control socket was retained")
    try:
        after = path.lstat()
    except FileNotFoundError:
        return
    if (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino):
        raise BridgeError("Owned SSH control socket changed; state was retained")
    path.unlink()


def ensure_tunnel(config, directory, port, owner):
    path = directory / "m"
    if path.exists() or path.is_symlink():
        if not stat.S_ISSOCK(path.lstat().st_mode):
            raise BridgeError("Owned SSH control path is not a socket")
        if control(config, directory, "check"):
            return
        retire_stale_socket(path, port)
    if not port_available(port):
        raise BridgeError("Local inference port is occupied; no process was stopped")
    owner["tunnelAttempted"] = True
    write_owner(directory / "owner.json", owner)
    result = run_ssh([
        *ssh_arguments(config), "-M", "-f", "-N", "-S", str(path),
        "-o", "ControlPersist=no", "-o", "ExitOnForwardFailure=yes",
        "-L", f"127.0.0.1:{port}:127.0.0.1:{port}", destination(config),
    ], timeout=25)
    if result.returncode or not control(config, directory, "check"):
        raise BridgeError("SSH tunnel startup outcome is unknown; reconcile ownership before retrying")


def close_tunnel(config, directory, port, owner):
    if not owner["tunnelAttempted"]:
        return
    path = directory / "m"
    if path.exists() or path.is_symlink():
        if not stat.S_ISSOCK(path.lstat().st_mode):
            raise BridgeError("Owned SSH control path is not a socket")
        if control(config, directory, "check"):
            if not control(config, directory, "exit"):
                raise BridgeError("Owned SSH tunnel did not confirm exit; owner record was retained")
        else:
            retire_stale_socket(path, port)
    deadline = time.monotonic() + 5
    while path.exists() or not port_available(port):
        if time.monotonic() >= deadline:
            raise BridgeError("Owned SSH tunnel shutdown is unconfirmed; owner record was retained")
        time.sleep(0.05)


def handle(request, config):
    if not isinstance(request, dict):
        raise BridgeError("Lifecycle request must be an object")
    action = request.get("action")
    if action == "describe-parameters":
        return remote_call(config, request)
    if action not in ("start", "status", "stop"):
        raise BridgeError("Unknown lifecycle action")
    identity = {}
    for key in ("instanceId", "experimentId", "parametersDigest"):
        value = request.get(key)
        if not isinstance(value, str) or not value:
            raise BridgeError(f"{key} must be a nonempty string")
        identity[key] = value
    endpoint = request.get("endpoint")
    if not isinstance(endpoint, dict) or not isinstance(endpoint.get("origin"), str):
        raise BridgeError("endpoint.origin must be http://127.0.0.1:<port>")
    origin = urlsplit(endpoint["origin"])
    if (origin.scheme != "http" or origin.hostname != "127.0.0.1" or not origin.port
            or origin.username is not None or origin.password is not None
            or origin.path or origin.query or origin.fragment):
        raise BridgeError("endpoint.origin must be http://127.0.0.1:<port>")
    port = origin.port
    private_directory(config["root"])
    directory = config["root"] / str(port)
    private_directory(directory)
    # OpenSSH adds a temporary suffix when publishing its control socket.
    if len(os.fsencode(directory / "m")) > 85:
        raise BridgeError("VLLM_SSH_STATE_DIR is too long for an SSH control socket; use a shorter private path")
    identity["configDigest"] = config["digest"]
    descriptor = os.open(directory / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = directory / "owner.json"
        owner = read_owner(path)
        if owner is not None and any(owner.get(key) != value for key, value in identity.items()):
            raise BridgeError("SSH bridge ownership or configuration changed; restore it before cleanup")
        if owner is None:
            if (directory / "m").exists() or (directory / "m").is_symlink():
                raise BridgeError("SSH control socket has no owner; reconcile it before continuing")
            if action != "start":
                response = remote_call(config, request, uuid.uuid4().hex, port)
                if response.get("status") != "stopped":
                    raise BridgeError("Remote service has no local bridge owner; reconcile before continuing")
                return response
            owner = {**identity, "generation": uuid.uuid4().hex, "tunnelAttempted": False}
            write_owner(path, owner)
        if action == "start":
            ensure_tunnel(config, directory, port, owner)
        response = remote_call(config, request, owner["generation"], port)
        if action == "status" and response.get("status") in ("starting", "ready"):
            ensure_tunnel(config, directory, port, owner)
        if action == "stop":
            if response.get("status") != "stopped":
                raise BridgeError("Remote service stop outcome is unknown; tunnel and owner were retained")
            close_tunnel(config, directory, port, owner)
            path.unlink()
        return response


def main():
    os.umask(0o077)
    try:
        response = handle(json.load(sys.stdin), configuration())
        print(json.dumps(response))
    except BridgeError as error:
        print("vLLM SSH bridge: " + str(error), file=sys.stderr)
        raise SystemExit(1) from None
    except Exception:
        print("vLLM SSH bridge failed; inspect configuration and owned state before retrying", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
