# Transpose-copy operator optimization

> English | [Simplified Chinese](./README.zh-CN.md)

This example uses `policy.operator-search` to evaluate a sealed Triton-Ascend
baseline, generate and repair candidates, select improvements, and independently
reassess the selected source. Optional hardware diagnostics drive further search
rounds. `application.kernel` owns source workspaces, `proposer.operator` proposes
edits, `summarizer.operator` records each completed attempt, and the Recipe binds `evaluator.operatorbench` for evaluation.
For both `evaluate` and `profile`, this RSI plugin calls the Evaluator SDK with
benchmark `kernel` and solver `kernel-replay`, then records the result as an RSI Measurement.

The task takes an FP16 tensor of shape `[381, 51200]` and returns a contiguous,
independently stored FP16 tensor of shape `[381, 80, 80, 8]`, preserving the input.
It reshapes the input, swaps the two spatial axes, and materializes a contiguous
copy of the transposed view.
The fixed case uses seed 42 and zero numerical tolerance. The entry point is
`kernel_function`. The frozen reference and contract are in [task](./task/task.json). Task contracts support FP16, BF16, FP32 and scalar tensors. Inputs may declare `contiguous: false`; omission keeps the contiguous-input default.

## Configuration and execution

The Recipe selects `input.py` with `application.config.entryFile`. To rename it, move the baseline file and update the entry path and its edit rule in the Target. The Agent reads a snapshot at `context/sources/<sourcePath>` and returns edits for paths in `editablePaths` in its stage input.

Use a Linux NPU host with CANN, torch, torch_npu, triton-ascend, and the profiling
dependencies required by the pinned Evaluator SDK. Set `MODEL_NAME`,
`MODEL_ENDPOINT`, and `MODEL_API_KEY` in private environment configuration.
The local Evaluator runs candidate Python with the evaluation account's file and
process permissions. Use this Recipe only for candidates trusted with that access.
Keep unrelated credentials and private files outside the evaluation account.

Set `benchmark.config.profiling.enabled` to collect profiling during ordinary evaluation. An explicit Policy profile action still collects fresh evidence. Evaluation imports the kernel entry and verifies it is callable, including aliases.

Before running [the Recipe](./recipe.search.yaml), replace its SDK Python path,
embedding Python path, model directory, identity file, external knowledge bundle,
and external retrieval script placeholders. Keep the hardware description in
[hardware-context.md](./hardware-context.md) consistent with the selected device.

The Policy supplies five generic proposer prompts through
`bindings.proposer.config.promptsDirectory` and a separate summary prompt
through `bindings.summarizer.config.promptFile`. The Recipe selects the local
[prompts directory](./prompts) and its [summary prompt](./prompts/summarize.md).
Relative paths resolve from the Recipe directory.

A custom proposer directory must contain `diagnose.md`, `diagnose-metrics.md`,
`generate.md`, `generate-metrics.md`, and `repair.md`. Keep `prompts/` alongside the Recipe when copying or
deploying this example. The installed RSI package supplies its own defaults and
does not depend on the repository's `examples/` directory.

Backend support and network access follow the configured Application, Evaluator
and Agent capabilities. Online research suggestions apply only when the chosen
Agent exposes authorized network tools. Prompt contents participate in analysis
identity; preserve the selected directory and contents when resuming a frozen
experiment.

The knowledge bundle and retrieval implementation are deployed independently.
`embedding.resourcesDirectory` points to the bundle root, containing
`knowledge/manifest.json` and its declared resources. `embedding.retrievalScript`
points to the worker invoked by `embedding.python`. The manifest records resource
SHA-256 digests. Model files, resources, prompts, and the worker participate in
identity checks. The plugin rejects missing files, digest mismatches, and results
whose identities differ from the request.

The manifest uses `schemaVersion: rsi.operator-knowledge/v1`, `resources` entries
with relative `path` and `sha256`, and `techniques` and `metrics` arrays whose
entries reference an `id`, `document`, and `example`. Optional `guidelines` names
an inventoried text resource. Deploy the bundle and worker from your chosen
knowledge provider as versioned inputs.

The worker command is `<embedding.python> <embedding.retrievalScript> --request
<json-path> --response <json-path>`. Requests use
`rsi.operator-retrieval-request/v1` and contain the model/resource locations and
digests, CPU encoding options, similarity threshold, and either static `issues`
or a metrics `query` with `mode: metrics`. Responses use
`rsi.operator-retrieval/v1`, echo the model and resource identities, and provide
`matches`, `knowledgeContext`, `omitted`, and runtime version information.
Matches reference inventoried techniques and their document/example digests.
The plugin validates this boundary and records the worker's own digest.

The embedding identity file uses `rsi.operator-embedding-identity/v1`, a `model`
object with `id` and immutable `revision`, an `encoding` object with
`queryPromptName: query`, `normalizeEmbeddings: true`, `device: cpu`, and
a positive `batchSize` (for example `32`), and a `files` inventory of relative paths and SHA-256 digests.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm ember-rsi validate examples/artifacts/kernel/transpose-copy/recipe.search.yaml
pnpm ember-rsi run examples/artifacts/kernel/transpose-copy/recipe.search.yaml --id transpose-copy-search-001
pnpm ember-rsi show transpose-copy-search-001
```

To resume, repeat `run` with the same Recipe and ID and add `--resume`. Keep the
inputs, build, and external resources identical. Completed resumes reuse recorded
results. Runtime data belongs in `.rsi/`.

The Recipe requires correct candidates and more than 2% lower mean latency for
selection. `finalValidity` records the independent final assessment, and
`finalTimingStable` checks whether selected and reassessed latency differ by at
most 5% of their mean. Treat these as observations under the recorded protocol.
Repeated real-device measurements are required to establish reliable speedups.
Manager enforces the Recipe's operation, model-call, evaluation, and time budgets.
Budget exhaustion stops execution through the standard failure/recovery path.

## Search modes and limits

One `policy.operator-search` handles both modes. Set `policy.config.metricsEnabled`
to `false` for static search only, or keep this example's `true` to follow static
search with measured bottleneck analysis.

Static search first assesses the baseline, then diagnoses the frozen source and
retrieves external guidance. Each new attempt starts from the entry candidate;
repairs start from the failed candidate. A valid but slower candidate is
summarized without promotion. An accepted improvement ends static search; an
empty static diagnosis skips candidate generation. Both paths can proceed to
the optional metrics stage.

The metrics stage profiles the current best candidate, analyzes its measured
bottlenecks, retrieves guidance, and generates a candidate from that incumbent.
It profiles each accepted improvement before the next round; without promotion,
the unchanged incumbent's diagnostic evidence is reused. Unavailable profiling
stops the metrics stage. Both modes independently reassess the selected source
at the end.

| Recipe setting                                                 | Example value | Meaning                                                                                                                                      |
| -------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy.config.maxAttempts`                                    | `3`           | Positive static attempt limit.                                                                                                               |
| `policy.config.repairLimit`                                    | `3`           | Nonnegative repair limit per invalid candidate chain.                                                                                        |
| `policy.config.maxRounds`                                      | `10`          | Positive metrics round limit.                                                                                                                |
| `policy.config.maxNoImprovement`                               | `5`           | Positive limit of valid candidates without promotion since the last promotion.                                                               |
| `bindings.proposer.config.historyWindow`                       | `5`           | Number of recent summaries delivered to generation; defaults to 5. Set `0` to omit recent summaries while retaining complete stored history. |
| `bindings.proposer.config.modelRequestTimeoutMs`               | `120000`      | One complete model stage's time limit, in ms; `0` disables this local deadline.                                                              |
| `bindings.proposer.config.embedding.timeoutMs`                 | `300000`      | Retrieval worker deadline, in ms; `0` disables it.                                                                                           |
| `bindings.proposer.config.embedding.maxPayloadBytes`           | Omitted       | Optional byte limit for each external retrieval JSON payload.                                                                                |
| `bindings.proposer.config.embedding.maxLogBytes`               | Omitted       | Optional byte limit for each retrieval worker output stream.                                                                                 |
| `bindings.proposer.config.embedding.similarityThreshold`       | `0.6`         | Minimum retrieval match score.                                                                                                               |
| `bindings.evaluator.config.benchmark.config.warmup` / `repeat` | `5` / `20`    | Evaluation warmup and timed repetitions.                                                                                                     |
| `bindings.selector.config.minRelativeImprovement`              | `0.02`        | Required relative reduction in eligible candidate mean latency.                                                                              |

This example's Manager limits are 1,024 operations, 65 evaluation runs, 152 model
calls, 7,200,000 ms elapsed time, and a 60,000 ms cleanup reserve. Evaluation runs
include both `evaluate` and `profile`; model calls include tool continuations and
delegates. Individual Agent requests and execution scopes can impose lower
configured limits. Raising the overall budget does not bypass those limits and
does not guarantee that every configured round will run. Both Proposer timeout
fields accept integer milliseconds from `0` to `2147483647` and keep the defaults
shown above. Omitted retrieval byte limits leave those dimensions unrestricted.
The Application [Target](./target.yaml) controls source and changed-byte limits;
this example explicitly sets both to 32,768 bytes. Raise or omit those Target
limits when authorizing larger sources.

## Ascend profiling setup

Use separate SDK and CPU embedding Python environments so installing embedding
dependencies does not replace the selected torch_npu/CANN environment. Deploy the
external retrieval worker's dependencies and model weights separately; the RSI
package does not install a knowledge provider or download weights during search.

The Recipe selects `benchmark.config.profiling.collection: Default`, with 25 warmup calls,
at most two collection attempts, and a 300-second limit per attempt. Its
`benchmark.config.profiling.enabled: false` disables automatic diagnostics during ordinary
evaluations. The Policy's explicit `profile` action still enables collection and
forces disk caching off.

Detailed collection requires working `msprof` and a compatible `mstx` module in
the selected SDK Python environment. Load the matching CANN environment first;
when selecting an isolated profiler installation, configure
`bindings.evaluator.config.benchmark.config.profiling.msprofBin` explicitly. Keep the interpreter,
device, collection mode, and actual tool versions with the run evidence. Do not
substitute the editable hardware-context template for observed device facts.

`Default` collects PipeUtilization, L2Cache, and ResourceConflictRatio CSV tables.
It marks timeline evidence as unavailable; it does not establish PipeTimeline,
overlap, bubble, or Double Buffer results. Choose `PipeTimeline,Default` explicitly
when usable trace evidence is required. The SDK owns collection, cleanup,
metric units, and evidence validation; see its pinned
[NPU kernel guide](https://github.com/evolving-foundry/ember-evaluator/blob/99392461cfdac9edb4ad2b49fa7c52a954125f1b/docs/users/benchmarks/kernel-npu.md).

## Results and verification

Inspect `bestCandidateRef`, `bestMeasurementRef`, `finalMeasurementRef`,
`finalValidity`, `finalTimingStable`, and `stopReason` in the Policy output.
`attempts`, `metricsRounds`, `diagnosticRefs`, and history references retain the
search decisions and their evidence. A completed experiment can retain the
baseline when no candidate improves it.

The selector checks constraints marked `prerequisite: true` first, regardless of their order in the Recipe. A measured `candidateValid: 0` skips the latency comparison and allows the Policy to attempt repair. A failed ordinary constraint retains the measured objective for feedback.

`candidateValid` describes correctness, `latencyMeanMs` is candidate mean device
latency, and `speedupVsReference` compares that candidate with the mathematical
PyTorch reference. To claim optimization of the original kernel, compare the
original and selected kernels under the same task, protocol, and environment;
the PyTorch ratio alone does not establish that gain.

For offline software checks, run `pnpm check` and `pnpm check:package`. These use
controlled workers and do not establish real NPU correctness or performance.
`validate` checks configuration; a real run must establish device readiness,
strict correctness, timing evidence, and confirmed cleanup. Preserve the
Manager facts and referenced immutable artifacts under `.rsi/`, including SDK
run IDs and raw evidence, when exporting an experiment. A summary or selected
source alone is insufficient for recovery or audit. Keep credentials outside
shared examples and exported records.

## Task provenance

The task copies were prepared from `../../kernel-tasks/qianchuan_top3_kernel`,
relative to the repository root. Runtime reads the included task copies. CRLF was
normalized to LF without other changes, and existing notices were retained.

| Original file | Original-byte SHA-256                                              | Included LF UTF-8 SHA-256                                          |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `input.py`    | `de4a94cc5092f5260b414609af0f34e4c12b5db4e1bedc0b78d18de2913c6d81` | `cfbd24fab79b29be38e9c4ebdd4298be60310ad5c9db31bfdcf3f245fd973bd8` |
| `problem.py`  | `1ae6e43d88d15ca0a6211662d2978dc59b8b1cc04c81f32df25b7140c64aecd8` | `8e4afaa3a4dde97a95f65dec490402cd2f93103af9c0201800f53883414f8f6a` |
| `test.py`     | `045f9d743e59fd97624885eec3fa894b9496820c3f8494208d594eb01f943dfe` | `407feea703eb23bc7eff8757edff5928841c1e76d29e205fd81f13ecea21a796` |

The included `test.py` records upstream behavior. Actual correctness and timing
come from the SDK's frozen reference and strict checker.
