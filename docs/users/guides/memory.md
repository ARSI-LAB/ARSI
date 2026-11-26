# Memory guide

English | [简体中文](memory_zh.md) · [Getting started](../getting-started.md)

Memory keeps reusable experience in a versioned directory of non-executable UTF-8 text files. Each experiment starts from a snapshot of its configured directory, or an empty tree when the directory is absent or unspecified. A successful update activates a new immutable version. Resume restores the experiment's active version.

## Enable or override Memory

Memory is enabled by default. A Policy sets `defaults.memory` and a Recipe overrides it with `memory`:

| Value | Behavior |
| --- | --- |
| Omitted | Recipe inherits `defaults.memory` from the Policy. If the Policy also omits it, Memory runs with built-in defaults. |
| `false` | Disable Memory. |
| `true` | Enable Memory using the Policy's `defaults.memory` configuration file if present, otherwise built-in defaults. |
| `{ configFile: <path> }` | Load a complete Memory YAML configuration file. The path resolves relative to the declaring Policy or Recipe file. A Recipe file completely replaces the Policy file; omitted fields inside that file use built-in defaults. |

### Built-in Policy defaults

| Policy | Default Memory behavior |
| --- | --- |
| `policy.wikiskill` | Enabled (`./memory.yaml`): `trigger: { on: after-step, step: train }`, `evidence.view: training`, `excludeSteps: [baseline, baseline_score, validate, test]`, custom `memory.md` prompt. |
| `policy.gym-rsi` | Enabled (`./memory.yaml`): `trigger: { on: after-step, step: train }`, `evidence.view: training`, `excludeSteps: [baseline, baseline_score, validate, promotion]`, shares WikiSkill's `memory.md` prompt. |
| `policy.harness2` | Enabled (`./memory.yaml`): `trigger: { on: loop-iteration }` (after each task), `evidence.view: execution` (verifier-blind), `targets.exclude: [selector]`, custom `memory.md` prompt. |
| `policy.gepa` | Enabled (`./memory.yaml`): `trigger: { on: loop-iteration }`, `evidence.view: training`, `includeSteps: [proposal, proposal_evaluation]`. |
| `policy.parameter-agent`, `policy.operator-search` | Enabled with built-in defaults (`loop-iteration`, `evidence.view: training`, all Policy bindings). |
| `policy.parameter-grid`, `policy.parameter-optuna` | Disabled by default (`defaults.memory: false`). |

## Configuration file reference

Every field in a Memory YAML file is optional; unknown fields fail validation. Relative paths inside the file resolve against the configuration file's directory. See the [runtime evolution schema](../../../src/contracts/runtime-evolution.ts) for the exact rules.

For compact feedback with bounded execution previews, a WikiSkill Recipe can select `memory: { configFile: ./wiki-memory.yaml }` with this configuration:

```yaml
directory: ./wiki
trigger: { on: after-step, step: train }
evidence:
  view: training-summary
  excludeSteps: [baseline, baseline_score, validate, test]
targets: { include: [proposer] }
budget:
  modelCalls: 12
  timeoutSeconds: 600
```

### Top-level fields

| Field | Required | Type / Values | Default | Purpose |
| --- | --- | --- | --- | --- |
| `directory` | No | Nonempty path string | Omitted (empty tree) | Seed directory snapshotted at experiment start and default write-back path for `arsi memory show/apply`. Must be a dedicated user-owned directory (no symlinks, junctions, protected trees such as `.rsi/` or `.git/`, or project/filesystem roots). If absent on disk, starts empty. |
| `trigger` | No | Object | `{ on: 'loop-iteration', every: 1 }` | Serial Policy boundary and cadence for running Memory updates. |
| `evidence` | No | Object | `{ view: 'training' }` | Evidence view and binding/step filters for each update window. |
| `targets` | No | Object | All Policy bindings | Which calling bindings receive the mounted Memory snapshot during `ctx.invokeAgent`. |
| `goal` | No | Nonempty path string | Built-in [`memory-agent/goal.md`](../../../src/plugins/memory-agent/goal.md) | UTF-8 nonempty text file describing what experience to consolidate. |
| `implementation` | No | Object | `memory.agent` (`contract.memory`) | Select and configure the Memory generator plugin. |
| `budget` | No | Object | `{}` (no local caps) | Per-invocation limits (`modelCalls`, `timeoutSeconds`, `evidenceBytes`). |

### `trigger` fields

| Field | Required | Allowed values | Default | Behavior |
| --- | --- | --- | --- | --- |
| `trigger.on` | No | `'loop-iteration'` \| `'loop-end'` \| `'experiment-end'` \| `'after-step'` | `'loop-iteration'` | `loop-iteration`: after each top-level loop iteration, or at experiment end when the Policy has no top-level loop.<br>`loop-end`: once when a top-level loop finishes.<br>`experiment-end`: once after the last top-level step, before the Policy finalizes its output.<br>`after-step`: after a serial step matching `trigger.step`. |
| `trigger.every` | No | Integer `>= 1` | `1` | Run on every *N*-th matching boundary (for example, `every: 2` runs on matches 2, 4, 6, ...). |
| `trigger.step` | Conditional | Nonempty step ID string | None | Required when `trigger.on` is `'after-step'` and forbidden otherwise. Must match a Policy step ID outside parallel `foreach` branches. |

Memory and Reflection track independent windows and match counts. When both match the same boundary, Memory runs first.

### `evidence` fields

| Field | Required | Allowed values | Default | Behavior |
| --- | --- | --- | --- | --- |
| `evidence.view` | No | `'training'` \| `'execution'` \| `'training-summary'` | `'training'` | `training`: authorized metrics and verifier feedback in `context/evolution/training-summary.json`, plus full redacted execution packets (`context/evolution/packets/index.json`) and files (`context/evolution/evaluation-index.json`), bounded by `budget.evidenceBytes`.<br>`execution`: full redacted execution packets and files without scoring or grading feedback. Use for verifier-blind Memory.<br>`training-summary`: compact call summaries and bounded execution previews with authorized scoring feedback.<br>See [Evidence](../concepts/architecture.md#evidence). |
| `evidence.includeBindings` | No | Unique `string[]` of Policy binding names | All Policy bindings | Restrict observed primary calls to the listed bindings declared in `require`. |
| `evidence.excludeBindings` | No | Unique `string[]` of Policy binding names | None | Exclude calls and derived measurements from the listed bindings. |
| `evidence.includeSteps` | No | Unique `string[]` of Policy step IDs | All Policy steps | Restrict observed Policy calls to the listed steps. |
| `evidence.excludeSteps` | No | Unique `string[]` of Policy step IDs | None | Exclude Policy calls from the listed steps (for example, validation or test splits). |

The Runtime collects calls, measurement projections, candidate diffs, and selector decisions within each window. An empty window skips generation.

### `targets` fields

| Field | Required | Allowed values | Default | Behavior |
| --- | --- | --- | --- | --- |
| `targets.include` | No | Unique `string[]` of Policy binding names | All Policy bindings | Calling bindings eligible to receive `context/memory/` when calling `ctx.invokeAgent`. |
| `targets.exclude` | No | Unique `string[]` of Policy binding names | None | Remove listed bindings from the eligible consumer set. Internal Memory and Reflection generators are always excluded. |

### `implementation` fields

| Field | Required | Allowed values | Default | Behavior |
| --- | --- | --- | --- | --- |
| `implementation.contract` | No | `'contract.memory'` | `'contract.memory'` | Public contract required of the selected plugin. |
| `implementation.ref` | No | Registered plugin ID | `'memory.agent'` | Plugin implementing `contract.memory`. |
| `implementation.config` | No | Plugin config object | `{}` | Configuration validated against the plugin's `configSchema` (see fields for `memory.agent` below). |

Built-in `memory.agent` accepts these fields under `implementation.config` (see [shared agent-editing schema](../../../src/plugins/shared/agent-editing/schema.ts)):

| Field | Required | Allowed values | Default | Behavior |
| --- | --- | --- | --- | --- |
| `implementation.config.agentRef` | No | Declared `contract.agent` binding name | Sole Policy `contract.agent` binding, else `_evolutionAgent` | Select which Agent runs Memory. When omitted, `memory.agent` reuses the only `contract.agent` binding declared by the Policy; if the Policy declares zero or multiple `contract.agent` bindings, Runtime creates `_evolutionAgent` using built-in `agent.pi` (`MODEL_NAME`, `MODEL_ENDPOINT`, `MODEL_API_KEY`). |
| `implementation.config.prompt` | No | Nonempty file path string | Built-in [`memory-agent/prompt.md`](../../../src/plugins/memory-agent/prompt.md) | Custom instruction file telling Memory how to organize and edit experience files. |
| `implementation.config.skills` | No | Array of directory path strings | `[]` | Local skill directories copied into `.agents/skills/` inside the Memory Agent workspace. |

### `budget` fields

| Field | Required | Allowed values | Default | Behavior |
| --- | --- | --- | --- | --- |
| `budget.modelCalls` | No | Integer `>= 0` | No local cap | Maximum new model calls in one Memory invocation (`0` blocks new model calls). |
| `budget.timeoutSeconds` | No | Integer `1`–`2147483` | No local cap | Maximum wall time in seconds for one Memory invocation. |
| `budget.evidenceBytes` | No | Integer `>= 1` | No module-level cap | Maximum bytes in the projected evidence snapshot. |

Experiment-level Recipe budgets and Agent backend timeouts still apply; see [Limits and budgets](configuration.md#limits-and-budgets).

## Read Memory during an Agent call

When an eligible binding calls `ctx.invokeAgent`, the Runtime mounts its pinned nonempty snapshot read-only at `context/memory/` in a derived copy of the caller's Agent project. `AGENTS.md` and `CLAUDE.md` list the read-only files. The resulting Agent call receipt records `metadata.memoryVersionRef`.

## Execution outcomes and persistence

| Status | Meaning |
| --- | --- |
| `activated` | Validated UTF-8 file changes were persisted as a new immutable version and activated for subsequent calls. |
| `no-change` | Generator returned no effective changes; the previous active snapshot remains in effect. |
| `skipped` | No usable observations appeared in the evidence window; generator was not invoked. |
| `rejected` | Generator failed, timed out locally, or proposed invalid edits (such as binary files, executable modes, or protected paths). The previously active snapshot stays active and the experiment continues. |

Experiment cancellation, experiment-wide budget exhaustion, and critical persistence errors still stop the experiment. Snapshots and records are stored under `.rsi/artifacts/` and `.rsi/facts/` (`memory-revisions`, `evolution-runs`).

## Keep experience for another experiment

```sh
arsi memory list my-experiment
arsi memory show <versionID> --to ./exported-wiki
arsi memory apply <versionID> --to ./exported-wiki
```

With a configured `directory`, preview and apply default to that recorded path. Supply `--to` for an experiment that started without one. Inspect additions, replacements and removals before applying a complete snapshot. The Dashboard offers the same preview and confirmation under **Reflection & Memory → Memory**. Apply requires a dedicated user-owned directory and no active or unresolved experiment in the store. To reuse retained experience, point a future Memory configuration at that directory.

See [Reflection](reflection.md) for revision of individual plugins' resources.
