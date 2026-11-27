# Models, Memory and Reflection

For installation and the shared baseline, see [quickstart](quickstart.md). The complete opt-in variant is [evolution-recipe.yaml](../assets/evolution/evolution-recipe.yaml) with [evolution.yaml](../assets/evolution/evolution.yaml) and the editor prompts in the same directory. It uses real `agent.pi`, `proposer.agent`, `memory.agent`, `reflection.agent` and the demonstration text evaluator. It does not measure benchmark intelligence.

## Choose the smallest complete workflow

| Need                     | Recipe and Policy                                                                           | Model-backed operations                    |
| ------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Proposal only            | [model-recipe.yaml](../assets/evolution/model-recipe.yaml), model-policy.yaml                | Proposer, one round                        |
| Memory                   | [memory-recipe.yaml](../assets/evolution/memory-recipe.yaml), memory-policy.yaml             | Proposer + Memory, two rounds              |
| Reflection               | [reflection-recipe.yaml](../assets/evolution/reflection-recipe.yaml), reflection-policy.yaml | Proposer + Reflection, two rounds          |
| Memory and Reflection    | evolution-recipe.yaml, evolution.yaml                                                         | Proposer + Memory + Reflection, two rounds |

Copy the base `assets/minimal/` as in quickstart, then copy the contents of `assets/evolution/` into the same destination. The overlay supplies its own `evolution-extension/`; pass both extension directories to the host. The model-only, Memory-only, Reflection-only and combined Recipes are alternatives, not a required sequence. The Memory-only and Reflection-only Recipes each cap total modelCalls at 20. These templates allow no-change; they do not guarantee that a stochastic model writes or activates a revision. To verify actual use, preserve the evidence chain described below and distinguish delivery from a subsequent observable effect.

## Model execution

Provide `MODEL_NAME`, `MODEL_ENDPOINT` (the provider's compatible API base) and `MODEL_API_KEY` in the launching environment without printing credentials. With user authorization for real requests:

```sh
arsi doctor .rsi/skill-demo/evolution-recipe.yaml --plugin-dir .rsi/skill-demo/extension --plugin-dir .rsi/skill-demo/evolution-extension
arsi run .rsi/skill-demo/evolution-recipe.yaml --plugin-dir .rsi/skill-demo/extension --plugin-dir .rsi/skill-demo/evolution-extension --id evolution-01
arsi show evolution-01
```

This variant permits at most 36 total model calls, 3 evaluations, 150 operations and 600000 ms, with 5000 ms cleanup reserve. Memory allows six model calls per update. Reflection allows six calls and 90 seconds per update. These are bounds, not expected usage. A model can return no-change or time out; do not increase budgets or retry indefinitely to force a demo to pass.

For proposer-only use, run the complete [model-recipe.yaml](../assets/evolution/model-recipe.yaml) and [model-policy.yaml](../assets/evolution/model-policy.yaml) variant. It declares `agent: { contract: contract.agent }`, binds that key to `agent.pi`, and gives `proposer.agent` `agentRef: agent`. Every Recipe binding must appear in the owning Policy’s `require`, even if called indirectly through a proposer. The default name `agent.default` is not an implicit registration or an exemption from this rule. Do not add an Agent binding to the unchanged deterministic `policy.skill-search`.

## Configure runtime evolution in a Recipe

Use top-level `memory` and `reflection` in the Recipe (`defaults.memory` / `defaults.reflection` in a Policy): `false` disables the module, `true` reuses a Policy `configFile` (or built-in defaults for Memory; load error for Reflection if no Policy file exists), and `{ configFile: <path> }` completely replaces the Policy file. When both match the same serial boundary, Memory runs first and Reflection second.

Every YAML configuration file rejects unknown fields (`additionalProperties: false`), and relative paths inside it resolve against that file's directory:

| Field | Applies to | Required | Allowed values / defaults |
| --- | --- | --- | --- |
| `directory` | Memory only | No | Dedicated user-owned directory path (seed snapshot at start; default write-back target for `arsi memory show/apply`; starts empty if absent or omitted). |
| `trigger` | Both | No | `{ on?, every?, step? }`. `on`: `'loop-iteration'` (default; falls back to experiment end without a top-level loop), `'loop-end'`, `'experiment-end'`, or `'after-step'`. `every`: integer `>= 1` (default `1`). `step`: serial Policy step ID outside parallel `foreach`, required iff `on` is `'after-step'`. |
| `evidence` | Both | No | `{ view?, includeBindings?, excludeBindings?, includeSteps?, excludeSteps? }`. `view`: `'training'` (default: full redacted traces + authorized feedback), `'execution'` (verifier-blind full redacted traces), or `'training-summary'` (bounded previews + feedback). `includeBindings`/`excludeBindings` take Policy binding names; Reflection also accepts `'memory'` (`includeBindings: [memory]` requires Memory enabled; `excludeBindings: [memory]` is allowed even when Memory is off). Step filters apply only to Policy calls. |
| `targets` | Memory | No | `{ include?, exclude? }` of Policy binding names eligible to receive `context/memory/` during `ctx.invokeAgent` (default: all Policy bindings; internal `_memory`/`_reflection` are always excluded). |
| `targets` | Reflection | **Yes** | `{ include, exclude? }` (`include` required, nonempty map). Keys are Policy binding names; values are `'*'`, `['*']` (all configured local `x-rsi-path` resources), or nonempty unique field names / `/` JSON pointers (e.g. `[prompt]`, `[promptsDirectory]`, `['/subagents/0/prompt']`). Targets must be regular local files or directories (no URLs or symlinks); at least one editable resource must remain after `exclude`. |
| `goal` | Both | No | Nonempty UTF-8 text file path (defaults to built-in Memory or generic Reflection goal). |
| `implementation` | Both | No | `{ contract?, ref?, config? }`. `contract`: `'contract.memory'` or `'contract.reflection'`. `ref`: registered plugin ID (default `'memory.agent'` / `'reflection.agent'`). Built-in `config` accepts `agentRef` (declared `contract.agent` binding; omitted reuses sole Policy Agent binding or creates internal `_evolutionAgent` via `agent.pi`), `prompt` (file path), and `skills` (array of local skill directory paths, default `[]`). |
| `budget` | Both | No | `{ modelCalls?, timeoutSeconds?, evidenceBytes? }`. `modelCalls`: integer `>= 0` (`0` blocks new model calls). `timeoutSeconds`: integer `1`–`2147483`. `evidenceBytes`: integer `>= 1`. |

- Memory mounts its pinned nonempty UTF-8 snapshot read-only under `context/memory/` in derived Agent projects of eligible callers and records `metadata.memoryVersionRef` on the call receipt.
- Reflection edits shared/nested resource roots once and produces one joint revision covering all affected bindings (`changedBindings`). Both `training` and `execution` views expose an observed Memory snapshot when available; `training-summary` exposes only the Memory update receipt.
- Empty evidence windows skip the generator (`skipped`). Ordinary proposal failures or invalid edits record `rejected` and keep the previous active snapshot/revision in place. Experiment cancellation, critical persistence errors and experiment-wide budget exhaustion still stop execution.

Inspect Memory and revisions using `arsi memory list <id>` and `arsi reflection list <id>`. The experiment's `evolution` summary identifies the resulting Memory snapshot and active revisions. A call receipt contains the version acquired by that binding.

## Acceptance evidence

For Memory: identify the new memory artifact, the subsequent Agent call receipt’s `metadata.memoryVersionRef`, loaded content delivered to its Agent, and subsequent executed candidate/evaluation. For Reflection: identify generated revision, accepted activation, a later invocation's revision identity and loaded Proposer instructions, then actual execution using it in the same unfinished task. Last-round activation has no subsequent execution and cannot establish online use. Report partial evidence honestly; file existence or a successful model response alone is insufficient.

The default two-round examples trigger each enabled module after each round. Later Agent receipts show which resources the second round acquired.

For custom Agents serving these editors, honor each request's `outputSchema`. The response contains `edits` and `reason`.

- For `proposer.agent`, every edit has an `op` and a path. Use `replace` or `create` with complete `content`, `patch` with `changes` containing exact `oldText` and `newText`, or `delete` with just the operation and path.
- For Memory and Reflection, edits have `path` and `content`. Use string content to write; Memory also accepts `null` to delete a file, whereas Reflection rejects file deletions and file-mode changes.

Paths are relative to the supplied editable file tree. Treat the `context/` and `sources/` projections as read-only. Submit edits for the Application to validate and apply.

## Budgeting real editing calls

One editor invocation is not one model request: `agent.pi` can request a file, receive it, and then produce its structured result over multiple requests. Reserve headroom for those turns; a three-request editor cap may run out even on a small task. Count baseline and all per-round proposer/Memory/Reflection invocations before choosing the experiment budget. Prefer the smallest mode needed: model-only, Memory-only, Reflection-only, or the combined example. Do not enable Memory merely to test Reflection.

A model can return malformed edits, no-change, or time out. Follow [bounded recovery](validation-and-troubleshooting.md#bounded-recovery), retaining task-level attempt limits across experiment IDs. Do not claim activation or online use from a successful overall experiment alone: Reflection can be skipped/rejected while the Policy continues. Verify the module's status and later effect explicitly. A custom single-request Agent may be appropriate for a small fully inline structured-output task, but report that as a different backend; it does not establish `agent.pi` reliability.

## Observe the right Reflection layer

Inspect `evolution-runs` and the experiment's `evolution.revisionRefs` for accepted revisions. List Memory snapshots with `arsi memory list <id>`. Keep the selected candidate and measurement alongside those references.

A raw generator receipt (the internal Reflection generator call, often binding `_reflection`) can return `{ status: 'proposed', proposal, reason }`. That is the generator contract, **not** the Runtime activation result. Do not assert that this raw output must equal `activated`. Link the evolution run's `revisionRefs` with the later proposer's call revisionRef and loaded Proposer instructions, then inspect its produced candidate and subsequent measurement. A revision fact labelled `validated` by itself is insufficient to show later use; the downstream evidence is required.
