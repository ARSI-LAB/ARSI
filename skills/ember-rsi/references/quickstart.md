# First successful experiment

## Environment and copy

Use Node 24.x and the project's supplied, built `ember-rsi` package. In a source checkout the prerequisite is `pnpm install --frozen-lockfile` and `pnpm build`; the pinned GitHub `ember-evaluator` dependency is installed and built through its own prepare lifecycle. Do not update the lockfile to bypass a missing dependency. A packaged consumer needs only the supplied package and its dependencies, not RSI source. Only `ember-rsi` and `ember-rsi/contracts` are public import paths.

Copy `assets/minimal/` from this skill to `.rsi/skill-demo/` beneath a Node workspace that can resolve the package. Keep its files together: `recipe.yaml`, `policy.yaml`, `target.yaml`, the complete `baseline/`, `extension/` and `run.mjs`. Node resolves imports relative to the importing file, not your shell directory.

This is the complete credential-free workflow. For model editing, Memory or Reflection, add the optional [learning assets](advanced.md). For an SDK benchmark, add the optional [TerminalBench assets](sdk-evaluators.md). Neither is required for the first run.

From the workspace root, with an installed binary:

```sh
ember-rsi doctor .rsi/skill-demo/recipe.yaml --plugin-dir .rsi/skill-demo/extension
ember-rsi run .rsi/skill-demo/recipe.yaml --plugin-dir .rsi/skill-demo/extension --id skill-demo-01
ember-rsi show skill-demo-01
ember-rsi list
node .rsi/skill-demo/run.mjs
```

CLI stores facts under the shell's `.rsi/`; `run.mjs` deliberately stores its independent facts in the copied starter's `.rsi/`. Use a fresh ID for each new experiment.

Doctor checks Recipe assembly and the bundled checks for its effective bindings. The starter's custom proposer and evaluator have no bundled doctor scripts, so their plugin-specific checks remain `unchecked`; registration and configuration are still checked. Review every failed or unchecked result before interpreting the report.

## Expected observations

`run.mjs` asserts success, two candidates with baseline/child lineage, two measurements with scores `[0,1]`, two released instances, and no duplicate measurements after resuming a succeeded experiment. The first proposal changes `prompt.md`; the second reports no-change. It uses the real `application.agentbundle`, artifact capture, candidate commit, instance leases, measurement validation and `selector.metric`. There are zero model calls and no Docker or network requirements.

The evaluator reads `prompt.md` and checks for the exact phrase `Check the answer`. It does not launch DSH or prove that an agent follows that instruction. The complete AgentBundle passes Application verification; running a real DSH benchmark additionally requires the benchmark environment and SDK service configuration.

## Adapt one boundary at a time

- Change allowed files in Target and include them in baseline. Preserve bundle integrity.
- Change deterministic behavior in `extension/operations.mjs`, preserving its contract inputs/outputs and cleanup.
- Change orchestration in `policy.yaml`, retaining a valid zero-round baseline result and the selected candidate/measurement pair.
- Replace the proposer with `proposer.agent` and configure an Agent binding for real model editing; see [advanced](advanced.md).
- Replace the demonstration evaluator with a real evaluator before making quality/performance claims; see [SDK evaluators](sdk-evaluators.md).

Do not run the model variant as part of a credential-free smoke check.
