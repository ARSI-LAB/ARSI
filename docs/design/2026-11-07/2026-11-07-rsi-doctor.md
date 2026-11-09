# Experiment preflight with `ember-rsi doctor`

First-release design completed 2026-11-10. Implementation and release acceptance are pending.

## Goal

Help an operator discover why a specific Recipe is likely to fail before starting an experiment.

- The `ember-rsi` agent Skill checks the Recipe against the operator's goal before an experiment and explains any mismatch in the conversation.
- The planned `doctor` command covers the checks available through `validate` and adds repeatable checks of experiment configuration and runtime prerequisites. A finding should identify what was checked and where the operator can act on it.

## Current behavior and evidence

- The CLI creates a Runtime with the selected plugin directories. `validateRecipe` uses its registry to load the Recipe, including the Policy, bindings, configuration Schemas, budget and applicable Reflection configuration. Application initialization occurs later during `run`. [CLI dispatch](../../../src/entries/cli/index.ts), [Recipe loader](../../../src/runtime/loaders/recipe.ts), [Manager](../../../src/runtime/manager/index.ts)
- In a November 7 reproduction using a temporary copy of the assembled Harness² Recipe, changing only `application.config.baseline.directory` to a nonexistent directory still produced `valid: true` from `validateRecipe`. This reproduction exercised Recipe validation only. [Harness² Recipe](../../../examples/harness/dsh-harness2/recipe.yaml), [validation entrypoint](../../../src/runtime/context.ts)
- The Skill currently directs the agent to validate the Recipe and then measure a baseline. Its TerminalBench helper already contains checks for task preparation, Docker capacity, bind mounts and model endpoint access from a container. It uses a pinned dataset and accepts task IDs on the command line. These observations come from inspecting the Skill and helper. [Skill workflow](../../../skills/ember-rsi/SKILL.md), [TerminalBench helper](../../../skills/ember-rsi/assets/terminalbench/terminalbench-preflight.mjs)
- A Policy declares its own dependencies, steps and output. The executor validates the output against the Policy's Schema. The existing external-plugin CLI test passed with an evaluator-free Policy whose steps are empty and whose output is `{ loaded: true }`. It exercises Application initialization and successful completion through `run`. [Policy declaration](../../../src/runtime/policy/policy.ts), [Policy executor](../../../src/runtime/policy/executor.ts), [CLI test](../../../tests/unit/external-plugins.test.ts)
- On November 9, a standalone script exercised the registered `application.agentbundle` implementation with the resolved Harness² configuration and temporary fact, artifact and workspace stores. It initialized the baseline, acquired a readable bundle instance and confirmed its release. After removing `plugins/office-base/prompts/baseline.md` from a temporary copy, `validateRecipe` returned `valid: true` and the plugin's `initialize` action reported the exact missing file. Across both cases the script observed zero Agent calls, zero experiments and zero remaining workspaces. [agentbundle](https://github.com/evolving-foundry/agentbundle) [Application](../../../src/plugins/application-agentbundle/service.ts), [file Application lifecycle](../../../src/plugins/shared/file-application/files.ts)
- On November 10, two registered plugin factories accepted valid configurations and rejected specific broken configurations during creation. `proposer.grid` rejected a repeated axis name and `selector.metric` rejected a constraint whose minimum exceeded its maximum. The probe disposed the valid instances and exercised only these configuration checks. [Grid proposer](../../../src/plugins/proposer-grid/service.ts), [metric selector](../../../src/plugins/selector-metrics/service.ts)

## Agreed scope

`ember-rsi doctor <recipe.yaml>` must work with an existing Recipe, Policy and plugin registrations as written. If the experiment already uses `--plugin-dir`, doctor uses the same directories. RSI supplies the built-in check scripts.

Doctor owns the association between an existing plugin implementation ID and its check script. Recipe loading already exposes the selected IDs. Doctor can look up a check using that information and pass it the resolved binding configuration. Plugin authors use the same package layout, public contract and `register(registry)` entrypoint they use for `run`, with zero additional registration calls or required files. [Validation entrypoint](../../../src/runtime/context.ts), [extension loader](../../../src/runtime/loaders/plugins.ts)

Preflight covers existing `validate` checks, declared local resources and bounded probes of applicable prerequisites, such as Docker capacity or access to a configured model endpoint. Scripts can exercise local plugin operations and query services for readiness without starting an Agent or requesting model inference. Real Policy execution belongs to `ember-rsi run`. Experiment authors can use doctor without adding a configuration field, writing a script or supplying a test case.

## Agreed default for plugin checks

Doctor automatically runs matching scripts for the implementations selected by the assembled Recipe. This includes its Application, its bindings after applying Policy defaults and Recipe overrides, and its configured Reflection implementation when present. Each check uses the effective configuration for that binding. A conditional branch can still be taken or skipped during the actual experiment. The scripts run as ordinary code whether an operator or an agent following the Skill invokes the CLI. [Recipe assembly](../../../src/runtime/loaders/recipe.ts)

- **Direct plugin check.** For a known, bounded operation such as the agentbundle lifecycle above, exercise it in temporary storage, verify the expected result and check cleanup. Select the operation by implementation and capability. For example, acquiring an `application.inference` instance can start a remote inference service even though both plugins implement the Application contract. [Inference Application](../../../src/plugins/application-inference/service.ts), [remote inference lifecycle](../../../src/plugins/application-inference/remote.ts)
- **Dependency check.** When a plugin's business operation would start an Agent or a benchmark, use a documented preparation or service probe that applies to that configuration. For example, the existing TerminalBench helper prepares selected task metadata through the SDK and checks model visibility from the gateway container. Report those observations at their actual scope. [TerminalBench helper](../../../skills/ember-rsi/assets/terminalbench/terminalbench-preflight.mjs)
- **Custom plugin without a matching script.** Return an explicit **not checked** (未检查) result for the plugin-specific check. Identify the binding, the implementation ID and the reason that no matching check script is available. The registration, contract and configuration checks still report their own results. A matched script that runs and detects a fault reports that fault. [Plugin operation contract](../../../src/contracts/operation.ts)

## Agreed Skill preflight for experiment intent

Before starting an experiment, the Skill compares the user's stated objective with the effective Recipe, including applicable Policy defaults and binding overrides. When it finds a mismatch, it identifies the user's goal, the specific setting and its consequence in the conversation. The review can use an objective, workload, baseline or constraint supplied by the user. Doctor's JSON and exit code are determined solely by its scripted checks. The CLI needs no conversational input. [Skill workflow](../../../skills/ember-rsi/SKILL.md), [binding resolution](../../../src/runtime/loaders/binding.ts)

For example, suppose the user wants to reduce P99 request latency. The selected metric is raw `requestLatency`, its statistic is `p99`, and `bindings.selector.config.direction` resolves to `maximize`. The Skill should point out that this setting favors higher P99 latency among eligible candidates. This observation belongs in the conversation even when doctor reports zero failures. [Metric selector configuration](../../../src/plugins/selector-metrics/schema.ts)

## Plugin authoring Skill

When the `ember-rsi` Skill creates a plugin, its workflow will prepare and verify a repeatable check for that implementation as separate doctor tooling. The guide will show how to use the binding's ordinary configuration and exercise both a working input and a concrete broken prerequisite. The Skill can test the script directly while developing it. An installed doctor reports the plugin as checked only after it finds and executes a matching script. [Skill workflow](../../../skills/ember-rsi/SKILL.md), [plugin authoring guide](../../../skills/ember-rsi/references/plugins.md)

## Agreed distribution of checks

The first release runs only check scripts bundled with the installed RSI version. A custom plugin can be installed and used before its check ships. The check becomes available when an RSI version containing it is installed. RSI owns this release step. Plugin developers can use their existing registration and configuration throughout.

## Check results and exit status

Each status describes one check. Doctor finishes independent checks, emits the collected report and returns `1` if any check is `failed`. A completed preflight with zero failures returns `0`, including when it contains `unchecked` entries.

- **Passed.** The check completed and verified the stated prerequisite.
- **Failed.** A check observed a fault, such as a missing required baseline, or its own script raised an error or timed out. Record the affected check, the reason and what it could establish. If a script cannot finish its probe, plugin availability remains unknown. Preserve findings from other checks, continue independent work, and mark any dependent check that could not run as `unchecked` with the reason.
- **Unchecked.** The check did not run. Give the reason, such as the absence of a matching script or a missing cached resource, and identify any prerequisite that prevented it.

For example, the following entry counts as one failure and gives the operator the evidence from the probe. The timeout alone adds no item to `missingResources`.

```json
{
  "id": "evaluator.gateway-model-access",
  "binding": "evaluator",
  "pluginId": "evaluator.agentbench",
  "status": "failed",
  "reason": "The gateway probe timed out before receiving a response. Plugin availability is unknown."
}
```

## Agreed default JSON output

A completed invocation of `ember-rsi doctor <recipe.yaml>` writes one JSON report to standard output, including when a prerequisite fails or a probe raises an error or times out. The Skill, CI and a person invoking the CLI all receive the same report. Help and command usage errors follow the existing CLI conventions. [CLI output](../../../src/entries/cli/index.ts)

The report below illustrates a structurally valid Recipe with a missing required baseline. This example would exit with code `1`.

```json
{
  "recipeId": "bundle-demo",
  "summary": { "passed": 1, "failed": 1, "unchecked": 2 },
  "missingResources": [
    {
      "binding": "application",
      "pluginId": "application.agentbundle",
      "field": "application.config.baseline.directory",
      "kind": "directory",
      "reference": "/work/bundle-demo/baseline",
      "checksNotRun": [
        "application.verify-bundle",
        "application.acquire-instance"
      ]
    }
  ],
  "checks": [
    { "id": "recipe.validate", "status": "passed" },
    {
      "id": "application.baseline",
      "binding": "application",
      "pluginId": "application.agentbundle",
      "status": "failed",
      "reason": "Required baseline directory is missing."
    },
    {
      "id": "application.verify-bundle",
      "binding": "application",
      "pluginId": "application.agentbundle",
      "status": "unchecked"
    },
    {
      "id": "application.acquire-instance",
      "binding": "application",
      "pluginId": "application.agentbundle",
      "status": "unchecked"
    }
  ]
}
```

`summary` counts the entries in `checks`. Check IDs are unique within a report. Each `missingResources` entry names a concrete path, image, dataset or other resource and lists the IDs of checks that did not run because of its absence. Multiple missing resources can point to the same unchecked result, which is counted once. A custom plugin without a matching script gets an `unchecked` entry whose `reason` identifies the absent script coverage. If registration or Recipe loading fails before the Recipe ID is established, `recipeId` is `null` and the report identifies the failed stage. Credential diagnostics name the field or environment variable and omit secret values.

## Agreed independence of run and doctor

`ember-rsi run <recipe.yaml>` can be the first command in an experiment workspace. It starts or resumes an experiment using its own startup checks, independently of whether doctor has ever run or what it reported. The Manager does not invoke doctor or consume a preflight report. [CLI dispatch](../../../src/entries/cli/index.ts), [Manager startup](../../../src/runtime/manager/index.ts)

When an agent uses the Skill to prepare an experiment, the Skill invokes the standalone `ember-rsi doctor` command in the intended execution environment and surfaces its findings. Operators and CI can also invoke doctor independently for diagnosis. [Current Skill workflow](../../../skills/ember-rsi/SKILL.md)

## Agreed handling of missing resources

Doctor reports missing resources without downloading them. This applies to implicit downloads by SDK preparation routines and container launches as well. Each finding names the affected binding, identifies the resource by its configured path, image reference or dataset version, and lists the checks that could not run because of it. Independent checks continue. A missing required local input is a failure. A cold cache alone leaves dependent checks unperformed when the experiment supports fetching the asset at runtime.

For example, suppose the TerminalBench evaluator's Docker daemon is reachable but the gateway image is absent. The following illustrates what to report. The implementation takes the exact image reference from the installed SDK. The existing standalone helper has a pull fallback, so doctor needs a cache-only path for these probes. [TerminalBench helper](../../../skills/ember-rsi/assets/terminalbench/terminalbench-preflight.mjs), [runtime preparation guide](../../../skills/ember-rsi/references/terminalbench-runtime.md)

- The `evaluator` binding is missing `node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c` in the selected Docker context.
- The workspace and cache mount check and the model endpoint check from the gateway container could not run.
- Docker daemon reachability and capacity can still be checked.

## Agreed first-release coverage

All 17 registered built-in implementations are in scope. A release check should compare the built-in IDs with the IDs covered by doctor and identify any omission. Each listed implementation needs a working example and a concrete fault its check detects. Checks may share existing parsers and lifecycle code. The following are design targets for the first release. [Built-in registrations](../../../src/runtime/builtins.ts)

### Applications and Agent backends

- `application.agentbundle` — Initialize the declared baseline in temporary storage, acquire a readable bundle and confirm release. A missing Target file or invalid bundle manifest must identify the failing resource. [Implementation](../../../src/plugins/application-agentbundle/service.ts)
- `application.inference` — Check the applicable launch prerequisites. For local startup, resolve the executable and referenced resources. For remote startup, check the configured interpreter, control script and baseline parameters file. Leave service startup to the Application during an experiment. [Configuration](../../../src/plugins/application-inference/schema.ts)
- `application.kernel` — Apply the kernel source verifier to the baseline. It requires a regular UTF-8 `input.py` declaring `kernel_function`. This check can run without compilation or an accelerator. [Implementation](../../../src/plugins/application-kernel/service.ts)
- `agent.pi` — Resolve the model, endpoint and credential environment references, and check the token limit against the context window. Diagnostics identify the missing field or variable and omit credential values. [Model configuration resolver](../../../src/plugins/agent-pi/service.ts)
- `agent.codex` — Resolve the configured executable using the launch environment and check whether it can be executed. Report the command or path if unavailable. [Configuration](../../../src/plugins/agent-codex/schema.ts)

### Proposers, search, Memory and Reflection

- `proposer.agent` — Resolve the configured Agent binding and prepare the editing project in temporary storage. Check the prompt, skills and subagent role files, including duplicate role names. [Proposer configuration](../../../src/plugins/proposer-agent/schema.ts), [project preparation](../../../src/plugins/shared/agent-editing/project.ts)
- `proposer.operator` — Read the operator task, stage prompts and external knowledge manifest from the configured locations. Report a missing stage prompt or invalid manifest before retrieval or model execution. [Implementation](../../../src/plugins/proposer-operator/service.ts)
- `proposer.grid` — Use the grid constructor to check the parameter path, unique axis names and safe grid cardinality. Duplicate axis names are detectable before generating a candidate. [Implementation](../../../src/plugins/proposer-grid/service.ts)
- `proposer.optuna` — Invoke the worker's existing `check` action with the configured Python executable. Report missing or incompatible Python, Optuna or NumPy dependencies. This action precedes study creation and trial sampling. [Worker](../../../src/plugins/proposer-optuna/python/worker.py)
- `search.prompt-evolution` — Validate the module list for duplicate IDs, duplicate paths and unsafe relative paths. Check the declared module files against the baseline when its contents are available. [Implementation](../../../src/plugins/search-prompt-evolution/service.ts)
- `memory.agent` — Resolve its Agent binding and load its editing prompt and configured guidance using the shared editor rules. A missing Agent binding or unreadable guidance should identify the corresponding field. [Memory implementation](../../../src/plugins/memory-agent/service.ts), [guidance loader](../../../src/plugins/shared/agent-editing/index.ts)
- `reflection.agent` — Resolve the Reflection Agent binding and prepare the configured prompt and bundled reviewer instructions. A missing reviewer prompt should be visible before an experiment produces Reflection evidence. [Implementation](../../../src/plugins/reflection-agent/service.ts)

### Evaluators and selectors

- `evaluator.agentbench` — Check the solver configuration against the adapter's `agentbundle` requirement. Detect a conflicting solver or an override of the RSI-owned bundle path. Use applicable cached task metadata and bounded environment probes for the selected benchmark. [Implementation](../../../src/plugins/evaluator-agentbench/service.ts)
- `evaluator.inferencebench` — Validate the selected solver service and its compatibility with the Application's `inference-endpoint`. Detect a missing service binding or an override of the model, endpoint or credentials supplied by the Application. Use only capability information available before launch. [Implementation](../../../src/plugins/evaluator-inferencebench/service.ts)
- `evaluator.operatorbench` — Load the local operator task and check `task.json`, `problem.py`, `test.py` and case identities. Report missing task files or duplicate case IDs without executing the kernel. [Task loader](../../../src/plugins/shared/operator-task.ts), [Evaluator](../../../src/plugins/evaluator-operatorbench/service.ts)
- `selector.metric` — Construct the selector with its effective configuration. Verify minimum and maximum bounds in both eligibility rules and constraints. This can diagnose contradictory bounds before any Measurement exists. [Implementation](../../../src/plugins/selector-metrics/service.ts)
- `selector.artifact` — Resolve the Agent binding, load the selector prompt and stage its configured skills in temporary storage. Report missing `SKILL.md` files or duplicate skill names. [Implementation](../../../src/plugins/selector-artifacts/service.ts), [project preparation](../../../src/plugins/shared/agent-editing/project.ts)

## Planned execution path

1. Dispatch the standalone CLI command with the Recipe path, existing extension directory options and the CLI cancellation signal. Keep `validate` as its existing standalone command and use the same Runtime registration and `Recipe.load` path for doctor. Load the Recipe once and retain the assembled definition for the remaining checks. An extension or Recipe loading error produces a failed finding with its cause. Binding checks require a successfully assembled Recipe. [CLI dispatch](../../../src/entries/cli/index.ts), [validation entrypoint](../../../src/runtime/context.ts)
2. Enumerate the selected bindings, including separate instances of the same implementation with different configurations. Use the existing Schema path annotations and resolved resource origins for common checks. Dispatch RSI's matching script against each binding and record the checks it can perform. [Binding resolution](../../../src/runtime/loaders/binding.ts), [declared path fields](../../../src/shared/config-paths.ts)
3. Read the experiment's inputs in their original locations. Use isolated, probe-owned storage for temporary instances and workspace writes. Bound active probes, pass cancellation through and release their resources on every exit path. Catch exceptions and per-probe timeouts at the check boundary so independent checks can still run. Record dependent checks that could not run and link confirmed missing resources to their affected check IDs.
4. Build counts and resource-to-check references from the collected results. Emit the JSON report once and apply the agreed exit rules. A Recipe that could not be loaded has no resolved bindings to enumerate.

### Implementation ownership

The CLI owns argument parsing, its cancellation signal, JSON output and the process exit code. An internal doctor runner in the packaged runtime owns check selection, deadlines, results and temporary storage. Its built-in script table uses the implementation IDs already registered by RSI. Each script receives the binding identity, resolved configuration, access to the inputs needed for its check and a bounded cancellation signal. Reuse validation and preparation logic from the owning plugin. The runner calls scripts directly and collects their findings before writing anything to standard output. [CLI parser](../../../src/entries/cli/commands.ts), [built-in registration](../../../src/runtime/builtins.ts)

A per-check deadline cancels that probe and its owned work. The runner completes its cleanup and proceeds with independent checks. If cleanup fails, it records the cleanup error with the affected probe. A whole-command interruption stops further dispatch, cancels active work and releases resources under the existing CLI interruption convention (exit `130`). Package the runner, bundled scripts and any required probe assets through the existing build so an installed consumer can use them from an experiment workspace. [CLI signal handling](../../../src/entries/cli/index.ts), [build](../../../scripts/build.mjs)

## Implementation acceptance scenarios

These are release criteria for the planned command. The earlier evidence section records the probes actually executed.

- **Installation and validation.** Run the packaged CLI from a consumer workspace with an existing extension directory. A valid Recipe selects its effective bindings. A broken extension or invalid binding produces a nonzero exit and a JSON diagnostic. An otherwise runnable fixture can also start directly with `run`. Ship doctor modules and probe assets in the installed package. [Build resource handling](../../../scripts/build.mjs), [consumer verification](../../../scripts/check-package.mjs)
- **Missing input and incomplete coverage.** Exercise a missing required baseline, an absent fetchable image, and a custom plugin without a script. Assert the status and exit code for each, that every `checksNotRun` ID names an unchecked result, and that an independent check still executes. Instrument the downloader or container launcher to verify zero fetches.
- **Script error and timeout.** In two deterministic cases, make a selected probe throw and exceed its deadline, respectively. In each case its check is `failed`, the reason describes the error or timeout, and plugin availability remains unknown. Verify an independent check still runs, a dependent check is `unchecked` with a reason, and the completed JSON report exits with code `1`. Only resources independently confirmed missing may appear in `missingResources`.
- **Isolation and cleanup.** Run an active plugin probe to completion, through a failure, and through cancellation. Verify that temporary instances and workspaces are released, the invoking experiment store gains no experiment or Measurement, and the report contains no credentials.
- **Conversation boundary.** Present the same deterministic Recipe and environment with two different stated goals, only one of which conflicts with the selector direction. The CLI produces identical JSON and exit codes. The Skill identifies the conflicting field in the conversation for the mismatched goal.
