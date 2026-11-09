#!/usr/bin/env python3
"""Local transport fixture: execute the real bootstrap and emulate SSH forwarding."""

import json
import io
import os
from pathlib import Path
import selectors
import socket
import subprocess
import sys


ROOT = Path(os.environ["RSI_SSH_FIXTURE_DIR"])


def record(value):
    with (ROOT / "ssh.jsonl").open("a") as stream:
        stream.write(json.dumps(value) + "\n")


def control(path, action):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(2)
        connection.connect(path)
        connection.sendall(action.encode())
        return connection.recv(16) == b"OK"


def master(path, port):
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    endpoint = socket.socket(socket.AF_UNIX)
    selector = selectors.DefaultSelector()
    bound = False
    try:
        server.bind(("127.0.0.1", int(port)))
        server.listen()
        endpoint.bind(path)
        bound = True
        endpoint.listen()
        selector.register(server, selectors.EVENT_READ, "http")
        selector.register(endpoint, selectors.EVENT_READ, "control")
        print("ready", flush=True)
        sys.stdout.close()
        while True:
            for key, _ in selector.select():
                connection, _ = key.fileobj.accept()
                with connection:
                    connection.settimeout(2)
                    message = connection.recv(8192)
                    if not message:
                        continue
                    if key.data == "control":
                        connection.sendall(b"OK")
                        if message == b"crash":
                            os._exit(0)
                        if message == b"exit":
                            return
                    else:
                        state = ROOT / "remote" / "service.json"
                        ready = state.exists() and json.loads(state.read_text())["status"] == "ready"
                        status = "200 OK" if ready else "503 Unavailable"
                        connection.sendall(
                            f"HTTP/1.1 {status}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".encode()
                        )
    finally:
        selector.close()
        server.close()
        endpoint.close()
        if bound:
            Path(path).unlink(missing_ok=True)


def main():
    args = sys.argv[1:]
    if args[0] == "--replay-bootstrap":
        payload = json.load(sys.stdin)
        wrapper = {"__name__": "ssh_wrapper", "__file__": payload["wrapper"]}
        exec(compile(Path(payload["wrapper"]).read_text(), payload["wrapper"], "exec"), wrapper)
        config = wrapper["configuration"]()
        envelope = {
            "launcher": config["launcher"], "sha256": config["sha256"], "env": config["env"],
            "request": payload["request"], "generation": payload["generation"],
            "port": payload["port"], "configDigest": payload["configDigest"],
        }
        sys.stdin = io.StringIO(json.dumps(envelope))
        exec(wrapper["REMOTE_BOOTSTRAP"], {"__name__": "__main__"})
        return 0
    if args[0] == "--master":
        master(args[1], args[2])
        return 0
    if args[0] == "--crash":
        return 0 if control(args[1], "crash") else 1
    if args[0] == "--cleanup":
        if (ROOT / "ssh.jsonl").exists():
            for line in (ROOT / "ssh.jsonl").read_text().splitlines():
                entry = json.loads(line)
                if entry.get("kind") == "master":
                    try:
                        control(entry["socket"], "exit")
                    except OSError:
                        pass
        return 0
    record({"kind": "argv", "args": args})
    if "-O" in args:
        action = args[args.index("-O") + 1]
        path = args[args.index("-S") + 1]
        if action == "exit" and (ROOT / "fail-tunnel-stop").exists():
            return 255
        if action == "check" and (ROOT / "fail-tunnel-check").exists():
            return 255
        try:
            return 0 if control(path, action) else 255
        except OSError:
            return 255
    if "-M" in args:
        path = args[args.index("-S") + 1]
        forwarding = args[args.index("-L") + 1]
        host, port, remote_host, remote_port = forwarding.split(":")
        assert host == remote_host == "127.0.0.1" and port == remote_port
        record({"kind": "master", "socket": path, "port": int(port)})
        child = subprocess.Popen(
            [sys.executable, __file__, "--master", path, port],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            text=True,
        )
        ready = child.stdout.readline().strip()
        child.stdout.close()
        if ready != "ready":
            child.wait(timeout=3)
            return 255
        return 0
    payload = sys.stdin.read()
    envelope = json.loads(payload)
    record({"kind": "request", "action": envelope["request"]["action"]})
    if (ROOT / "fail-transport").exists():
        return 255
    result = subprocess.run(args[-1], shell=True, input=payload, text=True)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
