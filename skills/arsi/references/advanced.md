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

Use the top-level `memory` and `reflection` fields in the examples. Each module runs at its declared serial boundary. The combined example runs Memory first and Reflection second, after each search iteration.

- Memory observes the configured bindings, receives Runtime-prepared evidence, and proposes a file-tree snapshot. Eligible bindings invoking Agents receive the pinned snapshot under `context/memory/` in the derived Agent project.
- To enable Reflection, supply a Policy or Recipe `configFile` with a nonempty `targets.include`. The example sets `proposer: '*'` to authorize the Proposer's local resources. Its only configured resource is `proposer.md`. `reflection: true` reuses a Policy file, and a Recipe file replaces it.
- The built-in generators reuse a Policy’s sole `contract.agent` binding. With zero or multiple Agent bindings they use an internal `agent.pi`. Set `implementation.config.agentRef` to select a declared Agent or `implementation.config.prompt` to supply a custom prompt. Memory and Reflection default to `evidence.view: training` for full traces and authorized feedback. Set `evidence.view: execution` for verifier-blind Policies or `training-summary` for compact previews with feedback. Use `evidence.includeSteps` and `evidence.excludeSteps` to scope observations. Set local limits in `budget`.
- Empty evidence windows skip the generator. Ordinary proposal failures leave the active version in place. Experiment cancellation and global budget limits still stop execution.

Inspect Memory and revisions using `arsi memory list <id>` and `arsi reflection list <id>`. The experiment's `evolution` summary identifies the resulting Memory snapshot and active revisions. A call receipt contains the version acquired by that binding.

## Acceptance evidence

For Memory: identify the new memory artifact, the subsequent Agent call receipt’s `metadata.memoryVersionRef`, loaded content delivered to its Agent, and subsequent executed candidate/evaluation. For Reflection: identify generated revision, accepted activation, a later invocation's revision identity and loaded Proposer instructions, then actual execution using it in the same unfinished task. Last-round activation has no subsequent execution and cannot establish online use. Report partial evidence honestly; file existence or a successful model response alone is insufficient.

The default two-round examples trigger each enabled module after each round. Later Agent receipts show which resources the second round acquired.

For custom Agents serving these editors, honor each request's `outputSchema`. The response contains `edits` and `reason`.

- For `proposer.agent`, every edit has an `op` and a path. Use `replace` or `create` with complete `content`, `patch` with `changes` containing exact `oldText` and `newText`, or `delete` with just the operation and path.
- For Memory and Reflection, edits have `path` and `content`. Use string content to write and null to delete an authorized file.

Paths are relative to the supplied editable file tree. Treat the `context/` and `sources/` projections as read-only. Submit edits for the Application to validate and apply.

## Budgeting real editing calls

One editor invocation is not one model request: `agent.pi` can request a file, receive it, and then produce its structured result over multiple requests. Reserve headroom for those turns; a three-request editor cap may run out even on a small task. Count baseline and all per-round proposer/Memory/Reflection invocations before choosing the experiment budget. Prefer the smallest mode needed: model-only, Memory-only, Reflection-only, or the combined example. Do not enable Memory merely to test Reflection.

A model can return malformed edits, no-change, or time out. Follow [bounded recovery](validation-and-troubleshooting.md#bounded-recovery), retaining task-level attempt limits across experiment IDs. Do not claim activation or online use from a successful overall experiment alone: Reflection can be skipped/rejected while the Policy continues. Verify the module's status and later effect explicitly. A custom single-request Agent may be appropriate for a small fully inline structured-output task, but report that as a different backend; it does not establish `agent.pi` reliability.

## Observe the right Reflection layer

Inspect `evolution-runs` and the experiment's `evolution.revisionRefs` for accepted revisions. List Memory snapshots with `arsi memory list <id>`. Keep the selected candidate and measurement alongside those references.

A raw generator receipt (the internal Reflection generator call, often binding `_reflection`) can return `{ status: 'proposed', proposal, reason }`. That is the generator contract, **not** the Runtime activation result. Do not assert that this raw output must equal `activated`. Link the evolution run's `revisionRefs` with the later proposer's call revisionRef and loaded Proposer instructions, then inspect its produced candidate and subsequent measurement. A revision fact labelled `validated` by itself is insufficient to show later use; the downstream evidence is required.
