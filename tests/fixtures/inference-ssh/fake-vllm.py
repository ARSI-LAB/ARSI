"""Deterministic vLLM lifecycle fixture; no accelerator or model is loaded."""

import json
import os
from pathlib import Path
import sys


root = Path(os.environ["VLLM_ASCEND_STATE_DIR"])
assert os.environ["VLLM_API_KEY"] == "fixture-secret-quote-'-$-value"
assert os.environ["VLLM_ASCEND_MODEL_PATH"] == "/fixture/model with spaces"
assert os.environ["ASCEND_RT_VISIBLE_DEVICES"] == "0"
root.mkdir(parents=True, exist_ok=True)
request = json.load(sys.stdin)
with (root / "requests.jsonl").open("a") as stream:
    stream.write(json.dumps(request) + "\n")
state = root / "service.json"
saved = json.loads(state.read_text()) if state.exists() else None
action = request["action"]
if action == "describe-parameters":
    result = {"parameters": {"max_num_seqs": {"flag": "--max-num-seqs", "kind": "integer"}}}
else:
    if saved and (saved["instanceId"] != request["instanceId"] or saved["parametersDigest"] != request["parametersDigest"]):
        raise RuntimeError("Another instance owns the remote port")
    if action == "start":
        if not saved:
            saved = {
                "instanceId": request["instanceId"],
                "parametersDigest": request["parametersDigest"],
                "parameters": request["parameters"],
                "status": "startup-failed" if (root / "fail-start").exists() else "ready",
                "reason": "Fixture startup failure",
                "resources": {
                    "verified": True,
                    "host": "fixture-host",
                    "devices": ["fixture-device"],
                    "modelIdentity": "fixture-model",
                    "software": "fixture-vllm",
                },
            }
            state.write_text(json.dumps(saved))
            with (root / "launches.jsonl").open("a") as stream:
                stream.write(json.dumps(saved) + "\n")
        result = saved
    elif action == "stop":
        if (root / "fail-stop").exists():
            raise RuntimeError("Fixture could not confirm remote stop")
        state.unlink(missing_ok=True)
        result = {"status": "stopped", "instanceId": request["instanceId"]}
    else:
        result = saved or {"status": "stopped", "instanceId": request["instanceId"]}
json.dump(result, sys.stdout)
