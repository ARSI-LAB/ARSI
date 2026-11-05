# Qianchuan top3 operator optimization

This example uses `policy.operator-search` to evaluate a sealed Triton-Ascend
baseline, generate and repair candidates, select improvements, and independently
reassess the selected source. Optional hardware diagnostics drive further search
rounds. `application.kernel` owns source workspaces, `proposer.operator` proposes
edits, and `evaluator.operatorbench` invokes the full Evaluator SDK.

The task takes an FP16 tensor of shape `[381, 51200]` and returns a contiguous,
independently stored FP16 tensor of shape `[381, 80, 80, 8]`, preserving the input.
The fixed case uses seed 42 and zero numerical tolerance. The entry point is
`kernel_function`. The frozen reference and contract are in [task](./task/task.json).

## Configuration and execution

Use a Linux NPU host with CANN, torch, torch_npu, triton-ascend, and the profiling
dependencies required by the pinned Evaluator SDK. Set `MODEL_NAME`,
`MODEL_ENDPOINT`, and `MODEL_API_KEY` in private environment configuration.

Before running [the Recipe](./recipe.search.yaml), replace its SDK Python path,
embedding Python path, model directory, identity file, external knowledge bundle,
and external retrieval script placeholders. Keep the hardware description in
[hardware-context.md](./hardware-context.md) consistent with the selected device.

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
`batchSize: 32`, and a `files` inventory of relative paths and SHA-256 digests.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm ember-rsi validate examples/artifacts/kernel/qianchuan-top3/recipe.search.yaml
pnpm ember-rsi run examples/artifacts/kernel/qianchuan-top3/recipe.search.yaml --id top3-search-001
pnpm ember-rsi show top3-search-001
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
