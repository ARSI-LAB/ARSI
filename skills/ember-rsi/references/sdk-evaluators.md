# Use the stock Evaluator SDK adapters

The starter's `evaluator.skill-text` demonstrates a legal custom evaluator. For real benchmarks bind `evaluator.agentbench` (requires an `agentbundle` instance) or `evaluator.inferencebench` (requires an `inference-endpoint` instance). Both run the installed Evaluator SDK in-process; a separate RSIRunner daemon is not required.

Both config schemas require `services` (nonempty object) and `benchmark` (name string or object). Optional fields are `environment`, `scheduler`, `store`, `reporter` (string or object), `metrics` (array), `run`, `deployment`, `output` (objects). Their nested provider-specific meaning belongs to the installed SDK; RSI's broad schema acceptance does not prove that a provider exists or accepts those fields.

## Complete TerminalBench campaign

Copy the base [starter](quickstart.md), then copy the contents of `assets/terminalbench/` into the same destination, including [terminalbench-recipe.yaml](../assets/terminalbench/terminalbench-recipe.yaml) and [terminalbench-policy.yaml](../assets/terminalbench/terminalbench-policy.yaml). This variant uses the real SDK evaluator, the bundled AgentBundle, a real model proposer and metric selection. It measures the baseline, proposes at most one changed candidate, evaluates it on the same task and retains the selected candidate/measurement pair. A no-change proposal retains the baseline. It does not use the synthetic text evaluator.

The default task is `terminal-bench/html-js-filter`, TerminalBench 4.0, one concurrent task, at most two evaluator calls and eight RSI model requests. The candidate editor may change only `prompt.md`. `successRate` is the intended metric for the supported adapter; verify its actual definition, availability, coverage and comparisonKey in results. Do not rename an unrelated metric to satisfy selection.

Follow [TerminalBench runtime preparation](terminalbench-runtime.md) and the bundled `terminalbench-preflight.mjs` for task assets, image identities, Docker context and solver gateway connectivity. These provide the public preparation path without repository source. Before launch, confirm:

- The supplied RSI/Evaluator packages and AgentBundle runtime dependencies are ready.
- The selected task and its benchmark assets are available; changing task IDs requires supported installed tasks, not invented IDs.
- Docker and the required images work in the actual executor environment. On ARM, `linux/amd64` requires working emulation; a successful schema check does not establish this.
- `MODEL_NAME`, `MODEL_ENDPOINT` and `MODEL_API_KEY` are securely provided. The solver must reach the endpoint from its execution environment; host localhost does not imply container reachability.
- The user authorizes the benchmark cost. The recipe limits each evaluator run to 300 seconds and the RSI stage to 900000 ms with cleanup reserve. RSI `modelCalls` counts editor calls, **not all benchmark solver requests**. Establish a separate solver/gateway spending limit before real execution; if unavailable, stop at prepared configuration.

```sh
ember-rsi doctor .rsi/skill-demo/terminalbench-recipe.yaml --plugin-dir .rsi/skill-demo/terminalbench-extension
# Run only after the prerequisites and external spending limit above are satisfied.
ember-rsi run .rsi/skill-demo/terminalbench-recipe.yaml --plugin-dir .rsi/skill-demo/terminalbench-extension --id terminalbench-01
ember-rsi show terminalbench-01
```

Record the baseline and proposed candidate refs, both comparable measurements if a proposal was created, selected pair, task/environment versions, native scores, coverage, actual usage and released resources. Confirm the native verifier actually produced a verdict: a timeout may have a valid accounting score of zero without running verification. Do not force improvement: retain the incumbent on a tie or regression according to selector behavior. This one-task adaptation experiment is not a held-out generalization estimate; use a disjoint final test set for that claim and keep its evidence out of proposals.

Doctor uses cached metadata and bounded readiness probes without downloading resources or requesting model inference. Missing fetchable resources leave dependent checks `unchecked`; prepare those resources separately using the runtime guide before repeating doctor.

This skill supplies the complete orchestration and baseline; it does not distribute benchmark images, task downloads, credentials or a spending-control service. The credential-free starter does not establish successful real TerminalBench execution. Report configuration validation, environment readiness and actual benchmark completion separately. See [bounded recovery](validation-and-troubleshooting.md#bounded-recovery) for failures.

## Existing algorithms

- `policy.harness2` performs base, invariant/domain proposals, composition and artifact selection; its dataset/k/concurrency and editor bindings differ from the starter. It uses execution-only learning evidence and requires actual delivery evidence for artifact selection.
- `policy.wikiskill` uses disjoint `dataset.trainTaskIds`, `validationTaskIds`, and `testTaskIds`. Its `maxRounds` limit defaults to 3. Held-out test runs after learning. A baseline must contain the editable skills declared in its Target.
- `policy.parameter-grid` uses grid proposals with an inference instance. Read [inference experiments](inference-experiments.md) for lifecycle and metric constraints.

`ember-rsi catalog` lists IDs only. Use [public schema lookup](plugins.md#discover-schemas-through-public-apis) to obtain a registered Policy's input/config/default schemas and implementation schemas. Prefer the complete starter when writing a new algorithm; do not infer a built-in Policy's binding keys from another Policy's examples. If a domain workflow needs machine-specific scripts, benchmark assets or a particular bundle, those are user/environment inputs; the skill cannot replace them.

## Result checks

The adapter records measurement items, execution/training/delivery evidence, metrics and provenance. Inspect measurement status, coverage, comparisonKey and definitions before selecting. A completed run with a score of zero is different from setup failure, partial coverage or unavailable metrics. Preserve candidate/measurement lineage and benchmark versions. No real SDK benchmark execution is established by the skill's deterministic text test.
