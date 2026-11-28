# Reflection guide

English | [简体中文](reflection_zh.md) · [Getting started](../getting-started.md)

Reflection proposes revisions to plugin resource files. The Runtime validates proposed edits, activates accepted revisions and creates plugin instances with the revised configuration. Subsequent calls record the acquired revision.

## Enable or override Reflection

A Policy sets `defaults.reflection` and a Recipe overrides it with `reflection`:

| Value | Behavior |
| --- | --- |
| Omitted | Recipe inherits `defaults.reflection` from the Policy. If the Policy also omits it, Reflection stays **off**. |
| `false` | Disable Reflection. |
| `true` | Enable Reflection using the Policy's `defaults.reflection` configuration file. **Load error** if the Policy provides no configuration file (Reflection always requires `targets.include`). |
| `{ configFile: <path> }` | Load a complete Reflection YAML configuration file declaring `targets.include`. The path resolves relative to the declaring Policy or Recipe file. A Recipe file completely replaces the Policy file. |

### Built-in Policy defaults

The six built-in Agent Policies each supply a Reflection configuration; Parameter Grid and Optuna disable Reflection by default:

| Policy | Default Reflection configuration |
| --- | --- |
| `policy.wikiskill` | Enabled (`./reflection.yaml`): `trigger: { on: loop-iteration }`, `evidence.view: training`, `excludeSteps: [baseline, baseline_score, validate, test]`, `targets.include: { proposer: '*' }`. |
| `policy.gym-rsi` | Enabled (`./reflection.yaml`): `trigger: { on: loop-iteration }`, `evidence.view: training`, `excludeSteps: [baseline, baseline_score, validate, promotion]`, `targets.include: { proposer: '*' }`. |
| `policy.harness2` | Enabled (`./reflection.yaml`): `trigger: { on: loop-iteration }` (after each task), `evidence.view: execution` (verifier-blind), `targets.include: { invariantProposer: '*', domainProposer: '*' }`, `budget: { timeoutSeconds: 3600 }`. |
| `policy.gepa` | Enabled (`./reflection.yaml`): `trigger: { on: loop-iteration }`, `evidence.view: training`, `includeSteps: [proposal, proposal_evaluation]`, `targets.include: { proposer: '*' }`. |
| `policy.parameter-agent` | Enabled (`./reflection.yaml`): `trigger: { on: loop-iteration }`, `evidence.view: training`, `targets.include: { proposer: '*' }`. |
| `policy.operator-search` | Enabled (`./reflection.yaml`): `trigger: { on: loop-iteration }`, `evidence.view: training`, `targets.include: { proposer: [promptsDirectory], summarizer: [promptFile] }`. |
| `policy.parameter-grid`, `policy.parameter-optuna` | Disabled by default (`defaults.reflection: false`). |

## Configuration file reference

A Reflection YAML file must declare `targets.include`; all other fields are optional, and unknown fields fail validation. Relative paths inside the file resolve against the configuration file's directory. See the [runtime evolution schema](../../../src/contracts/runtime-evolution.ts) for the exact rules.

This Harness²-style configuration grants access to the local resources of its two Proposers:

```yaml
trigger: { on: loop-iteration, every: 2 }
evidence: { view: execution }
targets:
  include:
    invariantProposer: '*'
    domainProposer: '*'
budget: { timeoutSeconds: 3600 }
```

### Top-level fields

| Field | Required | Type / Values | Default | Purpose |
| --- | --- | --- | --- | --- |
| `targets` | **Yes** | Object (`include` required, `exclude` optional) | None | Select which Policy bindings and local `x-rsi-path` resource fields Reflection may revise. |
| `trigger` | No | Object | `{ on: 'loop-iteration', every: 1 }` | Serial Policy boundary and cadence for running Reflection. |
| `evidence` | No | Object | `{ view: 'training' }` | Evidence view and binding/step filters for each reflection window. |
| `goal` | No | Nonempty path string | Built-in [`reflection-agent/goals/generic/prompt.md`](../../../src/plugins/reflection-agent/goals/generic/prompt.md) | UTF-8 nonempty text file describing what Reflection should improve. |
| `implementation` | No | Object | `reflection.agent` (`contract.reflection`) | Select and configure the Reflection generator plugin. |
| `budget` | No | Object | `{}` (no local caps) | Per-invocation limits (`modelCalls`, `timeoutSeconds`, `evidenceBytes`). |

### `targets` fields

| Field | Required | Allowed values | Behavior |
| --- | --- | --- | --- |
| `targets.include` | **Yes** | Nonempty map of `<bindingName>: '*' \| ['*'] \| string[]` | Grant edit access to configured local `x-rsi-path` resources of each listed Policy binding. |
| `targets.exclude` | No | Map of `<bindingName>: '*' \| ['*'] \| string[]` | Remove a binding (`'*'` / `['*']`) or specific fields from `targets.include`. At least one editable resource must remain. |

Per-binding selector syntax:

- `'*'` or `['*']`: Select all configured local `x-rsi-path` resources on that binding. On `proposer.agent`, this covers the main `prompt`, `messageTemplates`, `skills` directories and `subagents` role prompts. Remote URLs are skipped by wildcards; a wildcard with no local matches fails validation.
- `[field, ...]` (nonempty list of unique field names or JSON pointers starting with `/`, without `'*'`): Narrow access to specific `x-rsi-path` fields, such as `proposer: [prompt]`, `proposer: [promptsDirectory]`, `summarizer: [promptFile]`, or `proposer: ['/subagents/0/prompt']`. Selecting a collection field such as `skills` or `subagents` includes all configured `x-rsi-path` paths beneath it. Naming a field that is not in the plugin's `configSchema`, is not configured, or points to a remote URL fails validation.
- Every selected target must exist on disk as a regular local file or directory (symbolic links are rejected).

**Shared and nested resources.** When two selected fields refer to the same file, Reflection edits one copy. A selected directory also covers selected files inside it. If the project is reached through a symbolic link, use the same path to the project for all fields that share a resource. For example, a proposer can use `prompts/` while a summarizer uses `prompts/summarize.md`. Editing that file reloads both bindings. Editing another file in the directory reloads only the proposer. Each accepted update produces one joint revision for the experiment, covering all affected bindings.

### `trigger` fields

| Field | Required | Allowed values | Default | Behavior |
| --- | --- | --- | --- | --- |
| `trigger.on` | No | `'loop-iteration'` \| `'loop-end'` \| `'experiment-end'` \| `'after-step'` | `'loop-iteration'` | `loop-iteration`: after each top-level loop iteration, or at experiment end when the Policy has no top-level loop.<br>`loop-end`: once when a top-level loop finishes.<br>`experiment-end`: once after the last top-level step, before the Policy finalizes its output.<br>`after-step`: after a serial step matching `trigger.step`. |
| `trigger.every` | No | Integer `>= 1` | `1` | Run on every *N*-th matching boundary (for example, `every: 2` runs on matches 2, 4, 6, ...). |
| `trigger.step` | Conditional | Nonempty step ID string | None | Required when `trigger.on` is `'after-step'` and forbidden otherwise. Must match a Policy step ID outside parallel `foreach` branches. |

Memory runs before Reflection when both match the same boundary.

### `evidence` fields

| Field | Required | Allowed values | Default | Behavior |
| --- | --- | --- | --- | --- |
| `evidence.view` | No | `'training'` \| `'execution'` \| `'training-summary'` | `'training'` | `training`: combines authorized feedback in `context/evolution/training-summary.json` with redacted execution files, call records, eligible child Agent diagnostics and workspaces, and the updated Memory snapshot when available.<br>`execution`: full redacted execution files, call records, eligible child Agent diagnostics/workspaces, and Memory snapshot without scoring feedback. Use for verifier-blind Reflection.<br>`training-summary`: compact call summaries, bounded previews, authorized feedback, and only the Memory update receipt (no snapshot text).<br>See [Evidence](../concepts/architecture.md#evidence). |
| `evidence.includeBindings` | No | Unique `string[]` of Policy binding names and/or `'memory'` | All Policy bindings, plus `'memory'` when Memory is enabled | Restrict observed primary calls to the listed bindings. Explicitly listing `'memory'` requires Memory to be enabled. |
| `evidence.excludeBindings` | No | Unique `string[]` of Policy binding names and/or `'memory'` | None | Exclude calls from the listed bindings. A shared Reflection file may list `'memory'` in `excludeBindings` even when a Recipe disables Memory. |
| `evidence.includeSteps` | No | Unique `string[]` of Policy step IDs | All Policy steps | Restrict observed Policy calls to the listed steps (does not filter Memory update receipts). |
| `evidence.excludeSteps` | No | Unique `string[]` of Policy step IDs | None | Exclude Policy calls from the listed steps (for example, validation or test splits). |

**Memory snapshot isolation.** Both `training` and `execution` views expose the updated Memory snapshot when `memory` is observed. Because Memory may retain observations from its own evidence window, align Memory's filters with Reflection's held-out split or set `excludeBindings: [memory]`. Empty evidence windows skip the generator.

### `implementation` fields

| Field | Required | Allowed values | Default | Behavior |
| --- | --- | --- | --- | --- |
| `implementation.contract` | No | `'contract.reflection'` | `'contract.reflection'` | Public contract required of the selected plugin. |
| `implementation.ref` | No | Registered plugin ID | `'reflection.agent'` | Plugin implementing `contract.reflection`. |
| `implementation.config` | No | Plugin config object | `{}` | Configuration validated against the plugin's `configSchema` (see fields for `reflection.agent` below). |

Built-in `reflection.agent` accepts these fields under `implementation.config` (see [shared agent-editing schema](../../../src/plugins/shared/agent-editing/schema.ts)). It also includes a built-in `reflection-reviewer` subagent for delegating focused evidence checks:

| Field | Required | Allowed values | Default | Behavior |
| --- | --- | --- | --- | --- |
| `implementation.config.agentRef` | No | Declared `contract.agent` binding name | Sole Policy `contract.agent` binding, else `_evolutionAgent` | Select which Agent runs Reflection. When omitted, `reflection.agent` reuses the only `contract.agent` binding declared by the Policy; if the Policy declares zero or multiple `contract.agent` bindings, Runtime creates `_evolutionAgent` using built-in `agent.pi` (`MODEL_NAME`, `MODEL_ENDPOINT`, `MODEL_API_KEY`). |
| `implementation.config.prompt` | No | Nonempty file path string | Built-in [`reflection-agent/prompt.md`](../../../src/plugins/reflection-agent/prompt.md) | Custom instruction file telling Reflection how to analyze evidence and edit target resources. |
| `implementation.config.messageTemplates.default` | No | Local Markdown file path | Built-in task message | Override the task text. |
| `implementation.config.skills` | No | Array of directory path strings | `[]` | Local skill directories copied into `.agents/skills/` inside the Reflection Agent workspace. |

### `budget` fields

| Field | Required | Allowed values | Default | Behavior |
| --- | --- | --- | --- | --- |
| `budget.modelCalls` | No | Integer `>= 0` | No local cap | Maximum new model calls in one Reflection invocation (`0` blocks new model calls). |
| `budget.timeoutSeconds` | No | Integer `1`–`2147483` | No local cap | Maximum wall time in seconds for one Reflection invocation. |
| `budget.evidenceBytes` | No | Integer `>= 1` | No module-level cap | Maximum bytes in the projected evidence snapshot. |

Experiment-level Recipe budgets and Agent backend timeouts still apply; see [Limits and budgets](configuration.md#limits-and-budgets).

## Integrate a custom plugin with Reflection

To let Reflection revise a custom plugin's resources:

1. Declare editable file or directory fields in the plugin's `configSchema` with `'x-rsi-path': 'file'` or `'x-rsi-path': 'directory'` (see [`configSchema`](writing-plugins.md#configschema)).
2. Point the binding at local files or directories in the Policy or Recipe, and select those fields under `targets.include` in `reflection.yaml`.
3. Read the revised paths passed through `config` in `create(config, context)` so activated revisions take effect on subsequent calls.

## Execution outcomes and persistence

| Status | Meaning |
| --- | --- |
| `activated` | Validated edits were saved as a joint revision, materialized under `.rsi/experiments/<experiment-id>/revisions/<revision-id>/resources/`, and activated for all affected bindings (`changedBindings`). |
| `no-change` | Generator proposed no effective resource changes; active revisions stay unchanged. |
| `skipped` | No usable observations appeared in the evidence window; generator was not invoked. |
| `rejected` | Generator failed, timed out locally, or proposed invalid edits (such as editing outside `targets`, deleting files, changing file permissions, or writing non-UTF-8 content). Existing active revisions remain in effect and the experiment continues. |

Experiment cancellation, experiment-wide budget exhaustion, and critical persistence errors still stop the experiment. Records live under `.rsi/facts/` (`revisions`, `activations`, `evolution-runs`) and `.rsi/artifacts/`.

## Apply a revision to future experiments

Use `arsi reflection list <experiment-id>` to find a revision, newest first. A generated revision lists its affected bindings in `changedBindings`. Once all experiments in the same store have finished or been recovered, preview the cumulative changes with `arsi reflection show <revisionID>`. Use `arsi reflection apply <revisionID>` to write them to their recorded destinations.

> [!IMPORTANT]
> **Protected paths and in-place writes.** During an experiment, Reflection stores accepted revisions under `.rsi/` and hot-reloads the affected bindings for subsequent calls. The original files stay intact, including resources supplied by a built-in Policy.
>
> In-place `apply` refuses to overwrite the framework's `src/policies/` and `src/plugins/` trees, paths under `dist/`, `node_modules/`, `.rsi/` or `.git/`, the whole project root or a filesystem root. It also rejects a destination if the path itself or any ancestor is a symbolic link or Windows junction.
>
> A generated joint revision writes only resource roots whose contents or file modes differ from the initial snapshot. If only user-owned roots changed, an unchanged built-in root does not block their write-back. If a protected root changed, export the revision.

**To reuse a revised built-in resource in future experiments**

1. Run `arsi reflection show <revisionID> --to ./exported-resources`. Review the changes, use `sourceRoots` to identify each binding and resource, and check `destinations` for the actual export paths. In the Dashboard, open **Reflection & Memory → Reflection → Preview application**, enter the export directory, and select **Preview destination**.
2. Run `arsi reflection apply <revisionID> --to ./exported-resources` to export to a dedicated user-owned directory whose path contains no symbolic links or junctions. A revision with one directory root places its contents directly there. Bindings that share a root share its export path.
3. Edit the corresponding binding in `recipe.yaml` to point to the exported files or directories. For a Proposer, this might mean changing `prompt`, an entry in `skills`, or a role's `subagents[].prompt`. Later experiments can load and revise those copies in place.

**For repeated in-place updates**, put every resource you intend to evolve in a dedicated subdirectory of your own project when you first write the Recipe. Point the binding at those copies before starting the experiment. Run `arsi doctor recipe.yaml` and check `reflection.targets` for a built-in resource export notice. Use `reflection show` to verify the write destinations for a particular revision.

To restore the baseline, preview and apply the **Initial version**. Its preview compares every selected root with the current destination. Use `arsi reflection apply <initialRevisionID> --to ./baseline` to export the complete baseline. See [Memory](memory.md) for the shared experience directory.
