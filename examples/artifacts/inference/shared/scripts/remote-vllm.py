#!/usr/bin/env python3
"""Remote inference lifecycle template. Implement start, status and stop.

Application invokes a new local process for each command, sends one JSON request
on stdin and expects one JSON response on stdout. Write diagnostics to stderr.
Keep host, model and device settings here. Add SSH or another deployment method.

Recipes with remote.discoverParameters enabled also need describe_parameters.
Application sends {"action": "describe-parameters"} before the lifecycle begins.

Application reads the candidate's tuning.json into LifecycleRequest.parameters.
Echo instanceId and the opaque parametersDigest in the response. A stopped
response needs only status and instanceId. A ready response includes resources
with queried identities. Application polls status until ready, then checks the
configured health URL.
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


class ParameterCatalogResponse(TypedDict):
    parameters: dict[str, dict[str, JsonValue]]


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


def parse_request(raw: dict[str, object]) -> LifecycleRequest:
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


def describe_parameters() -> ParameterCatalogResponse:
    """Return a nonempty catalog of installed, tunable engine options.

    Query the deployment's serving CLI and limit the results to the options
    intended for tuning. Describe each option's flags and accepted value shape.
    A catalog with one supported option would look like this.

        {"parameters": {
            "max_num_seqs": {"flag": "--max-num-seqs", "kind": "integer"}
        }}

    Use the same set of supported options to validate a start request.
    """
    raise NotImplementedError(
        "Implement describe_parameters() to query the installed serving CLI"
    )


def start(request: LifecycleRequest) -> LifecycleResponse:
    """Start this instance and report its readiness or confirmed rejection.

    Validate request["parameters"] and map JSON values to vLLM arguments (for example,
    max_num_seqs -> --max-num-seqs; booleans use the appropriate flags and
    structured values need explicit serialization). Null is a value, not omission.
    Use request["memoryUtilization"] for --gpu-memory-utilization. It already
    includes a candidate override when allowed. Use request["endpoint"]["model"]
    as the served name.
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
    raw = json_object(json.load(sys.stdin), "request")
    response: LifecycleResponse | ParameterCatalogResponse
    if raw.get("action") == "describe-parameters":
        response = describe_parameters()
    else:
        request = parse_request(raw)
        handlers = {Action.START: start, Action.STATUS: status, Action.STOP: stop}
        response = handlers[request["action"]](request)
    print(json.dumps(response))


if __name__ == "__main__":
    main()
