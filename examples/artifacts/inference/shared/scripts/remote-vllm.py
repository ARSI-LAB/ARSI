#!/usr/bin/env python3
"""Remote inference lifecycle template. Implement the three functions below.

Application invokes a new local process for each command, sends one JSON request
on stdin and expects one JSON response on stdout. Write diagnostics to stderr.
Keep host/model/device settings here; add SSH or another deployment method.

LifecycleRequest defines the input: Application reads the candidate's tuning.json
into parameters. LifecycleResponse defines the output: echo instanceId and the
opaque parametersDigest from the request. A stopped response needs only status
and instanceId; ready requires resources with queried identities, never invented
values. Application polls status until ready, then checks the configured health URL.
"""

import json
import math
import sys
from enum import Enum
from typing import Literal, TypeAlias, TypedDict


JsonValue: TypeAlias = (
    None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
)


class Action(str, Enum):
    START = "start"
    STATUS = "status"
    STOP = "stop"


class Endpoint(TypedDict):
    origin: str
    model: str


class LifecycleRequest(TypedDict):
    action: Action
    experimentId: str
    instanceId: str
    parametersDigest: str
    parameters: dict[str, JsonValue]
    memoryUtilization: float
    endpoint: Endpoint


class Resources(TypedDict):
    verified: Literal[True]
    host: str
    devices: list[str]
    modelIdentity: str
    software: str


class ResponseDetails(TypedDict, total=False):
    parametersDigest: str
    resources: Resources
    reason: str


class LifecycleResponse(ResponseDetails):
    status: Literal["stopped", "starting", "ready", "capacity-rejected", "startup-failed", "failed"]
    instanceId: str


def json_object(value: object, field: str) -> dict[str, object]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise TypeError(field + " must be a JSON object")
    return {str(key): item for key, item in value.items()}


def text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TypeError(field + " must be a nonempty string")
    return value


def number(value: object, field: str) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise TypeError(field + " must be a finite number")
    return value


def json_value(value: object, field: str) -> JsonValue:
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, (int, float)):
        return number(value, field)
    if isinstance(value, list):
        return [json_value(item, field + "[]") for item in value]
    result: dict[str, JsonValue] = {}
    for key, item in json_object(value, field).items():
        if key in ("__proto__", "constructor", "prototype"):
            raise ValueError(field + "." + key + " is forbidden")
        result[key] = json_value(item, field + "." + key)
    return result


def parse_request(value: object) -> LifecycleRequest:
    raw = json_object(value, "request")
    endpoint = json_object(raw.get("endpoint"), "endpoint")
    utilization = float(number(raw.get("memoryUtilization"), "memoryUtilization"))
    if not 0 < utilization <= 1:
        raise ValueError("memoryUtilization must be in (0, 1]")
    return LifecycleRequest(
        action=Action(text(raw.get("action"), "action")),
        experimentId=text(raw.get("experimentId"), "experimentId"),
        instanceId=text(raw.get("instanceId"), "instanceId"),
        parametersDigest=text(raw.get("parametersDigest"), "parametersDigest"),
        parameters={key: json_value(item, "parameters." + key)
                    for key, item in json_object(raw.get("parameters"), "parameters").items()},
        memoryUtilization=utilization,
        endpoint=Endpoint(origin=text(endpoint.get("origin"), "endpoint.origin"),
                          model=text(endpoint.get("model"), "endpoint.model")),
    )


def start(request: LifecycleRequest) -> LifecycleResponse:
    """Start this instance and report its readiness or confirmed rejection.

    Validate request["parameters"] and map JSON values to vLLM arguments (for example,
    max_num_seqs -> --max-num-seqs; booleans use the appropriate flags and
    structured values need explicit serialization). Null is a value, not omission.
    Use request["memoryUtilization"] for
    --gpu-memory-utilization, and request["endpoint"]["model"] as served name.
    Persist ownership and process identity remotely before returning. Never
    replace another instance, or launch a duplicate on a repeated start.
    Report capacity-rejected only for confirmed insufficient memory. Report
    startup-failed with the parameter digest and a sanitized reason for other
    confirmed candidate launch rejections. Raise for unknown outcomes or
    transport failures. Calibration may start and stop temporary instances.
    """
    raise NotImplementedError("Implement start(): deploy vLLM using the supplied parameters")


def status(request: LifecycleRequest) -> LifecycleResponse:
    """Query this instance and report readiness or an observed startup rejection.

    Verify persisted ownership and actual process identity. When ready, include
    queried Resources. Before start, report stopped only when
    absence is confirmed; do not mistake an unrelated service for this instance.
    After starting, return startup-failed for confirmed launch rejections and
    keep the matching instance available for stop confirmation.
    """
    raise NotImplementedError("Implement status(): query remote ownership and readiness")


def stop(request: LifecycleRequest) -> LifecycleResponse:
    """Stop only this instance and its descendants; confirm absence before stopped.

    Support repeated stop and cleanup after a partial start, including after the
    local caller was cancelled. Preserve ownership evidence on unknown outcomes.
    """
    raise NotImplementedError("Implement stop(): terminate and confirm owned cleanup")


def main() -> None:
    request = parse_request(json.load(sys.stdin))
    handlers = {Action.START: start, Action.STATUS: status, Action.STOP: stop}
    response = handlers[request["action"]](request)
    print(json.dumps(response))


if __name__ == "__main__":
    main()
