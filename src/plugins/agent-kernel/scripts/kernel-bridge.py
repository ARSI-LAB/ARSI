#!/usr/bin/env python3
"""Kernel-agent bridge: one RSI agent proposal per invocation.

Protocol (the same bounded one-shot JSON seam as the lifecycle scripts):
  stdin : {"goal", "prompt", "input", "files", "outputSchema", "maxModelCalls"}
  stdout: {"edits": [{"path", "content"}...], "reason", "modelCalls"}

`files` carries the editable candidate workspace plus read-only context
(`context/...`, `sources/...`). The bridge proposes one optimized variant of
the primary kernel source via ngo-agent's kernel strategy (NPU constraint
prompt template + LLM provider + deterministic candidate scan); the checksum
hard gate stays with the evaluator and the AST scan repeats at the lifecycle
precheck, so a bridge compromise cannot alone produce an activated candidate.

Model credentials come from the process environment (NGO_LLM_BASE_URL,
NGO_LLM_MODEL, LLM_API_KEY, NGO_LLM_MAX_TOKENS); the bridge never persists
them. Controlled
failures print {"error": "..."} on stdout and exit nonzero; stderr is
diagnostic only and may contain host configuration.
"""

import json
import os
import re
import sys
from typing import Dict, List, Tuple

MAX_FEEDBACK_CHARS = 4000
MAX_MEMORY_CHARS = 16000

# Same extraction heuristics as ngo_agent's kernel strategy: prefer the longest
# fenced block with Python code features, else cut from the first code line.
_CODE_FEATURE = re.compile(r"^(import\s|from\s|@triton|def\s|tl\.)")
_FENCE = re.compile(r"```(?:python)?\s*\n(.*?)```", re.DOTALL)


class BridgeError(RuntimeError):
    """A proposal-level failure; mapped to an explicit error response."""


def code_block(raw: str) -> str:
    blocks = [
        block
        for block in _FENCE.findall(raw)
        if _CODE_FEATURE.search(block) or "triton" in block.lower()
    ]
    if blocks:
        return max(blocks, key=len).strip()
    lines = raw.splitlines()
    for index, line in enumerate(lines):
        if _CODE_FEATURE.search(line):
            return "\n".join(lines[index:]).strip()
    raise BridgeError(
        f"LLM response contains no kernel source: first 120 chars: {raw[:120]!r}"
    )


def editable_files(files: Dict[str, str]) -> Dict[str, str]:
    return {
        path: content
        for path, content in sorted(files.items())
        if not path.startswith(("context/", "sources/"))
    }


def primary_kernel(files: Dict[str, str]) -> Tuple[str, str, str]:
    """Return (path, name, source) of the single kernel proposed this round."""
    kernels = {
        path: content
        for path, content in files.items()
        if path.endswith(".py") and not path.endswith("wrapper.py")
    }
    if not kernels:
        raise BridgeError(
            "no kernel source in the editable scope (expected one .py file)"
        )
    path = next(iter(kernels))
    name = os.path.splitext(os.path.basename(path))[0]
    return path, name, kernels[path]


def evidence_feedback(evidence: object) -> str:
    """Compact last-round digest for the strategy prompt's feedback slot."""
    measurements = (
        evidence.get("measurements")
        if isinstance(evidence, dict)
        else None
    )
    parts: List[str] = []
    if isinstance(measurements, list):
        for item in measurements:
            if isinstance(item, dict):
                for key in ("finalText", "summary", "error"):
                    text = item.get(key)
                    if isinstance(text, str) and text.strip():
                        parts.append(text.strip())
    feedback = "\n".join(parts) if parts else json.dumps(evidence, default=str)
    return feedback[:MAX_FEEDBACK_CHARS]


def memory_block(memory: object) -> str:
    """Cross-run memory wiki sections (`[{path, content}]`, newest first).

    Sits between the strategy template and the skill pack so it informs the
    proposal without outranking the skill guidance or the task prompt."""
    if not isinstance(memory, list):
        return ""
    sections = [
        f"### {item.get('path', 'memory')}\n\n{item.get('content', '').strip()}"
        for item in memory
        if isinstance(item, dict)
        and isinstance(item.get("content"), str)
        and item.get("content").strip()
    ]
    if not sections:
        return ""
    return (
        "\n\n## 跨轮经验记忆 (kernel-opt memory)\n\n"
        + "\n\n".join(sections)[:MAX_MEMORY_CHARS]
    )


def skills_block(skills: object) -> str:
    if not isinstance(skills, list):
        return ""
    sections = [
        item.get("content").strip()
        for item in skills
        if isinstance(item, dict) and isinstance(item.get("content"), str)
    ]
    if not sections:
        return ""
    return "\n\n## 补充领域技能 (RSI skill pack)\n\n" + "\n\n".join(sections)


def strategy():
    """Build (build_prompt, complete, scan) from ngo-agent's kernel strategy."""
    from ngo_agent.agents.kernel_agent import KernelGenAgent, scan_candidate
    from ngo_agent.agents.llm_provider import LLMProvider, LLMProviderConfig

    config = LLMProviderConfig(
        api_key=os.environ.get("LLM_API_KEY", ""),
        base_url=os.environ.get("NGO_LLM_BASE_URL", "http://127.0.0.1:1"),
        model=os.environ.get("NGO_LLM_MODEL", "stub"),
        verify_ssl=False,
        no_proxy_bypass=True,
        # Reasoning models (e.g. glm-5.3-flash) can run an unbounded thinking
        # chain on "improve this kernel" prompts and never emit the answer
        # within any practical timeout; a bounded generation cap turns that
        # into a fast finish_reason=length the retry loop can react to.
        max_tokens=int(os.environ.get("NGO_LLM_MAX_TOKENS", "16384")),
    )
    provider = LLMProvider(config)
    agent = KernelGenAgent(provider)
    return agent.build_prompt, provider.complete, scan_candidate


def load_check(candidate: str, name: str):
    """Exec the candidate module once; return an error string when it cannot
    load. Triton failures like invalid ``triton.Config`` kwargs surface at
    decoration time, so this keeps unloadable candidates from reaching the
    NPU instance precheck (which cannot feed errors back into the loop)."""
    import importlib.util
    import tempfile

    handle_fd, tmp_path = tempfile.mkstemp(suffix=".py", prefix=f"bridge_{name}_")
    try:
        with os.fdopen(handle_fd, "w", encoding="utf-8") as handle:
            handle.write(candidate)
        spec = importlib.util.spec_from_file_location(
            f"bridge_load_check_{name}", tmp_path
        )
        if spec is None or spec.loader is None:
            return "candidate module cannot be loaded"
        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        except Exception as error:  # noqa: BLE001 - any load failure is feedback
            return f"{type(error).__name__}: {error}"
        return None
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def propose(request: dict) -> dict:
    build_prompt, complete, scan_candidate = strategy()
    files = request.get("files")
    if not isinstance(files, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in files.items()
    ):
        raise BridgeError("request.files must map text paths to text content")
    path, name, source = primary_kernel(editable_files(files))
    payload = request.get("input") or {}
    if not isinstance(payload, dict):
        raise BridgeError("request.input must be an object")
    constraints = payload.get("editConstraints")
    constraints = constraints if isinstance(constraints, dict) else {}
    bottleneck = constraints.get("bottleneck")
    bottleneck = bottleneck if isinstance(bottleneck, str) and bottleneck else "memory"
    device_specs = constraints.get("deviceSpecs")
    device_specs = device_specs if isinstance(device_specs, dict) else {}

    budget = request.get("maxModelCalls")
    budget = budget if isinstance(budget, int) and budget > 0 else 1
    base_prompt = build_prompt(
        name,
        source,
        bottleneck,
        device_specs,
        evidence_feedback(payload.get("evidence")),
    ) + memory_block(payload.get("memory")) + skills_block(payload.get("skills"))
    # The strategy template tells the model to keep the captured kernel's
    # signature; the caller's task prompt carries the scenario's binding
    # contract and must supersede it, so it lands last.
    task_prompt = request.get("prompt")
    if isinstance(task_prompt, str) and task_prompt.strip():
        base_prompt += "\n\n## 任务指令 (RSI proposer binding)\n\n" + task_prompt
    feedback = ""
    last_error: Exception = BridgeError("model budget exhausted before a proposal")
    model_calls = 0
    while model_calls < budget:
        prompt = base_prompt
        if feedback:
            prompt += (
                "\n\n## 上次候选被拒绝的反馈 (fix and return a corrected kernel)\n\n"
                + feedback
            )
        raw = complete(prompt, meta={"source": "rsi-agent-kernel"})
        model_calls += 1
        try:
            candidate = code_block(raw)
        except BridgeError as error:
            feedback = str(error)
            last_error = error
            continue
        violations: List[str] = scan_candidate(candidate)
        if violations:
            feedback = (
                "deterministic safety scan rejected the candidate: "
                + "; ".join(violations)
            )
            last_error = BridgeError(feedback)
            continue
        load_error = load_check(candidate, name)
        if load_error is not None:
            feedback = f"candidate failed to import/load: {load_error}"
            last_error = BridgeError(feedback)
            continue
        reason = (
            f"Optimized {name} for the {bottleneck} bottleneck under the NPU "
            "constraint template; subject to the evaluator hard gate."
        )
        return {
            "edits": [{"path": path, "content": candidate}],
            "reason": reason,
            "modelCalls": model_calls,
        }
    raise last_error


def main() -> None:  # pragma: no cover - exercised through integration runs
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise BridgeError("request must be a JSON object")
        response = propose(request)
    except Exception as error:  # noqa: BLE001 - one explicit failure channel
        message = str(error) if isinstance(error, BridgeError) else (
            f"{type(error).__name__}: {error}"
        )
        json.dump({"error": message}, sys.stdout)
        sys.stdout.write("\n")
        raise SystemExit(1)
    json.dump(response, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
