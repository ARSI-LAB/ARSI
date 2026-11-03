# Inference and MTP campaigns

Apply [experiment workflow](experiment-workflow.md); this reference specializes it without hardcoding a model, host or desired gain.

## Reuse and known gaps

The registered `policy.parameter-grid` uses `proposer.grid`, `evaluator.inferencebench` and `selector.metric`. Use `ember-rsi catalog` to check IDs and [public schema lookup](plugins.md#discover-schemas-through-public-apis) for configuration schemas on the installed version. Inference Application config has the same Target/baseline pair as [Recipes](recipes.md), plus exactly one of:

- Local: `start: { argv: [...] }`, `endpoint: { model, basePath? }`. Application owns the launched process and allocated endpoint.
- Remote: `remote: { script, executable?, parametersFile?, timeoutMs? }`, `endpoint: { origin, model, basePath? }`. A supplied adapter implements start/status/stop for the authorized environment; an arbitrary SSH command is not that protocol.

Optional healthcheck contains path/intervalMs/timeoutMs; shutdown contains gracePeriodMs; credentials.apiKeyEnv is an environment variable **name**, not a secret. `parametersFile` names a candidate-relative file. All machine/model/device values are environment-specific. This skill does not bundle a deployment implementation or claim arbitrary accelerator support. Obtain the environment's working lifecycle adapter and benchmark config before launching; missing ones are an integration task, not something to guess from a successful schema check.

The existing Policy enumerates numeric grid points through `contract.proposer-grid` and selects a feasible best measurement. It does not independently measure a baseline before that grid, profile bottlenecks, edit kernels, call Memory/Reflection, or prove numerical correctness. Include the baseline point or measure it separately. Do not rebind it to `proposer.agent`, whose contract differs. Reuse the inference Application, SDK-backed Evaluator and selector where suitable; compose an agent-editing Policy or add a narrow correctness/profile adapter only for demonstrated gaps.

The repository's vLLM example configures AgentX replay through the Evaluator SDK. Confirm the installed SDK's benchmark identity/version, metrics and semantics match the user's requested InferenceX AgentX; names alone are insufficient. Example concurrency, trace variant and latency constraints are illustrative, not evidence of fit for another model. Verify TTFT/TPOT metric availability and units in actual results; whole-request latency is not TTFT or TPOT. Missing metrics require an explicit supported adapter rather than renamed substitutes.

The repository example remote script's `start`, `status` and `stop` raise `NotImplementedError`: it is a lifecycle template, not a working SSH deployment adapter. Implement and verify these operations for the authorized environment before claiming a runnable remote experiment. Reuse the Application protocol rather than replacing the framework.

## Preflight and references

When execution is authorized, inspect exact model metadata/weights/tokenizer and MTP assets, hardware model/architecture/device memory, driver/firmware, CANN/runtime/compiler and engine versions. Verify single-device capacity, engine/model/MTP compatibility and the actual supported precision. Do not infer support from a model label or use lossy quantization to meet a lossless requirement. Missing required weights, hardware, dependencies or usable cards is a blocker.

Search applicable official CANN, TileLang and engine implementations and architecture constraints before proposing changes. Record source URLs, versions, applicable constraints and validated conclusions in a reusable reference skill. Freeze each reference version after establishment; keep experiments and writable experience outside it. For corrections create a new reference version rather than modifying a frozen version. Search current techniques when requested, but validate applicability on the actual machine.

Remote lifecycle ownership must track each owned process/container, port and device. Select only verified available cards with an allocation mechanism that prevents races. One instance uses one card when required; free cards do not imply safe simultaneous benchmarking. Avoid interference and never terminate unrelated workloads. Keep secrets in local environment/credential facilities.

## Fair measurement and correctness

Make MTP-enabled end-to-end measurements the final criterion. Pin workload traces/split/seed, tokenizer, input/output distributions, MTP settings, engine/software revision, precision, warmup, repetition, timing boundaries and metric statistics. Use real profiles to justify overlap, chunking, fusion, caching, pipelines or scheduling changes; microbenchmarks are auxiliary evidence.

Find a feasible concurrency range with measured peak memory and headroom, including KV cache, long contexts and MTP overhead. Record failed/OOM points. Keep a fixed common workload/concurrency comparison for causal gains; report each version's separately capacity-tuned maximum as an additional result. Do not change workload size or incomplete replay coverage to create apparent gains.

Specify a reliable reference and justified absolute/relative tolerances by dtype and operation, plus coverage across shapes, lengths, batch/concurrency, boundaries, masks, cache reuse and complete MTP draft/verify/accept/reject paths. Include intermediate logits/tensors or equivalent reliable numerical evidence and end-to-end checks; final text alone is insufficient. Failures or insufficient coverage disqualify a candidate from best-correct selection. Performance/SLO metrics do not substitute for this gate. The stock performance Policy needs an explicit correctness gate before it can enforce this requirement.

## Example acceptance translation

For a request targeting TTFT reduction of at least 20%, TPOT reduction of at least 30%, and doubled throughput, record baseline values B and candidate values C under the same declared statistics/conditions. Require `C_TTFT <= 0.80 * B_TTFT`, `C_TPOT <= 0.70 * B_TPOT`, and `C_throughput >= 2 * B_throughput`, plus the correctness and single-card gates. Respect stricter wording if the user requires strictly greater gains. Gains on separate candidates do not establish one implementation meeting all targets.

The selector supports one objective with absolute constraints, not a general multiobjective optimizer or automatic baseline-relative thresholds. After baseline measurement, derive supported absolute constraints from real metric values, or add orchestration for multiple workload gates. Keep baseline thresholds fixed across the campaign; changing stage objectives must not erase final regression checks. Repeat final baseline/best comparisons and report noise/variation, partial failures and coverage. Do not promise that a skill can achieve the requested speedups.
