# Models, Memory and Reflection

For installation and the shared baseline, see [quickstart](quickstart.md). The complete opt-in variant is [learning-recipe.yaml](../assets/learning/learning-recipe.yaml) with [learning.yaml](../assets/learning/learning.yaml), [reflection.yaml](../assets/learning/reflection.yaml), prompts and guidance in that same directory. It uses real `agent.pi`, `proposer.agent`, `memory.agent`, `reflection.agent` and the demonstration text evaluator. It does not measure benchmark intelligence.

## Choose the smallest complete workflow

| Need                     | Recipe and Policy                                                                           | Model-backed operations                    |
| ------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Proposal only            | [model-recipe.yaml](../assets/learning/model-recipe.yaml), model-policy.yaml                | Proposer, one round                        |
| Memory                   | [memory-recipe.yaml](../assets/learning/memory-recipe.yaml), memory-policy.yaml             | Proposer + Memory, two rounds              |
| Reflection               | [reflection-recipe.yaml](../assets/learning/reflection-recipe.yaml), reflection-policy.yaml | Proposer + Reflection, two rounds          |
| Both learning mechanisms | learning-recipe.yaml, learning.yaml                                                         | Proposer + Memory + Reflection, two rounds |

Copy the base `assets/minimal/` as in quickstart, then copy the contents of `assets/learning/` into the same destination. The overlay supplies its own `learning-extension/`; pass both extension directories to the host. The model-only, Memory-only, Reflection-only and combined Recipes are alternatives, not a required sequence. The Memory-only and Reflection-only Recipes each cap total modelCalls at 20. These templates allow no-change; they do not guarantee that a stochastic model writes or activates a revision. To verify actual use, preserve the evidence chain described below and distinguish delivery from a subsequent observable effect.

## Model execution

Provide `MODEL_NAME`, `MODEL_ENDPOINT` (the provider's compatible API base) and `MODEL_API_KEY` in the launching environment without printing credentials. With user authorization for real requests:

```sh
ember-rsi validate .rsi/skill-demo/learning-recipe.yaml --plugin-dir .rsi/skill-demo/extension --plugin-dir .rsi/skill-demo/learning-extension
ember-rsi run .rsi/skill-demo/learning-recipe.yaml --plugin-dir .rsi/skill-demo/extension --plugin-dir .rsi/skill-demo/learning-extension --id learning-01
ember-rsi show learning-01
```

This variant permits at most 36 total model calls, 3 evaluations, 150 operations and 600000 ms, with 5000 ms cleanup reserve. Proposer and Memory allow 6 calls each; Reflection has its own 6-call/90-second scope. These are bounds, not expected usage. A model can return no-change or time out; do not increase budgets or retry indefinitely to force a demo to pass.

For proposer-only use, run the complete [model-recipe.yaml](../assets/learning/model-recipe.yaml) and [model-policy.yaml](../assets/learning/model-policy.yaml) variant. It declares `agent: { contract: contract.agent }`, binds that key to `agent.pi`, and gives `proposer.agent` `agentRef: agent`. Every Recipe binding must appear in the owning Policy’s `require`, even if called indirectly through a proposer. The default name `agent.default` is not an implicit registration or an exemption from this rule. Do not add an Agent binding to the unchanged deterministic `policy.skill-search`.

## Memory wiring

The complete learning Policy initializes `state.memory: null`, passes it as `memoryRef` to the proposer, calls `memory` with required `memoryRef`, `goal`, `evidenceRefs`, and stores the returned reference for the next iteration. Memory returns either `updated` with `memoryRef`, `changeRef`, `reason`, or `no-change` with unchanged/nullable `memoryRef`, null `changeRef`, `reason`. It does not automatically alter candidates or binding configuration.

Editor config requires `prompt` (file). Optional `guidance` is a directory, `skills` is a directory list, `evidenceView` is `execution` (default) or `training-summary`, and `agentRef` defaults to `agent.default`. Set `budget.modelCalls` to bound model requests on backends that support accounting. Agent instructions are in `AGENTS.md`, input and evidence are under `context/`, and editable snapshots are under `candidate/`. Use the workspace tools to inspect files and express final edit paths relative to `candidate/`. Follow the supplied output schema. The business editor and Application apply and validate the returned edits. Read an existing file when needed, but do not ask the model to read a new Memory file before creating it. Keep each edit path unique, relative and a file; never return `.` as an edit. Do not invent a `{ files: ... }` response when implementing a custom Agent.

Evidence references are measurement identities, not arbitrary local paths. Use `readEvidence(refs, { view, maxBytes })` to obtain authorized content. `execution`, `training-summary` and `delivery` have different data boundaries. Preserve an algorithm's train/validation/test split; never leak held-out evaluation into learning.

## Current Reflection protocol

A Policy containing `type: reflection` must declare `defaults.reflection.configFile` so it can compile. A Recipe may override the selected complete file with `reflection.configFile`; file contents do not merge. The module declares:

```yaml
evidence: [proposer, evaluator, selector, memory]
targets:
  proposer:
    resources: [guidance]
goal: ./reflection-goal.md
implementation:
  contract: contract.reflection
  ref: reflection.agent
  config:
    agentRef: agent
    evidenceView: execution
budget:
  modelCalls: 6
  timeoutSeconds: 90
```

All evidence/target names are **binding keys**. Resource names are configured top-level Schema path fields such as `guidance`: not `/guidance`, not filesystem paths, and not `bindings/proposer/...`. The target binding must configure that existing resource. Built-in `reflection.agent` receives a default prompt if omitted. Do not set implementation.config.maxModelCalls or maxContextBytes for this module: modelCalls belongs in budget, and context handling is internal. Configuration numeric tuning, `rules`, `when`, `activation`, `acceptance` and `onFailure` from the old rule protocol are unsupported.

Invoke explicitly at a serial Policy boundary:

```yaml
- id: improve_guidance
  type: reflection
```

No ordinary `require.reflection` or Recipe binding is needed. The Reflection step takes no `use`, `with` or per-call configuration fields. Configuring a file alone does not invoke Reflection. The included Policy calls it after completed calls and Memory, leaving another iteration to consume activated guidance. Do not place it in concurrent branches.

Evidence requires at least **three eligible completed calls** in the scoped execution; merely listing three binding names is insufficient. The **Policy step output** (`steps.improve_guidance.output` in the examples) contains `reflectionId`, `status` (`activated`, `no-change`, `skipped`, `rejected`), `reason`, and `revisionRefs`. Insufficient evidence can legitimately return skipped. Structural acceptance means the revision is within resource boundaries, not that its quality is better.

`revisionRefs` is an object keyed by binding name, not an array. For a revision to the `proposer` binding, an activated result has the shape `{ status: 'activated', revisionRefs: { proposer: '<revision-ref>' }, ... }`. Read `result.revisionRefs.proposer`; for multiple affected bindings, iterate `Object.entries(result.revisionRefs)`. Non-activated results can have an empty object. A later call receipt has a singular `revisionRef` string (or `null`), which should equal the entry for that call's binding.

## Acceptance evidence

For Memory: identify the new memory artifact, the next proposer's input `memoryRef`, loaded content delivered to its Agent, and subsequent executed candidate/evaluation. For Reflection: identify generated revision, accepted activation, a later invocation's revision identity and loaded guidance, then actual execution using it in the same unfinished task. Last-round activation has no subsequent execution and cannot establish online use. Report partial evidence honestly; file existence or a successful model response alone is insufficient.

The learning examples update Memory/Reflection only when another round will consume the result. They still run both proposer/evaluation rounds. Add a final update only when you explicitly need a saved result for later handoff; otherwise it spends budget without demonstrating additional online use. Consequently, `reflectionResults` has one entry for the default two-round example, not one entry per round.

For custom Agents serving these editors, honor each request's `outputSchema`. The response contains `edits` and `reason`.

- For `proposer.agent`, every edit has an `op` and a path. Use `replace` or `create` with complete `content`, `patch` with `changes` containing exact `oldText` and `newText`, or `delete` with just the operation and path.
- For Memory and Reflection, edits have `path` and `content`. Use string content to write and null to delete an authorized file.

Paths are relative to the supplied editable file tree. Treat the `context/` and `sources/` projections as read-only. Submit edits for the Application to validate and apply.

## Budgeting real editing calls

One editor invocation is not one model request: `agent.pi` can request a file, receive it, and then produce its structured result over multiple requests. Reserve headroom for those turns; a three-request editor cap may run out even on a small task. Count baseline and all per-round proposer/Memory/Reflection invocations before choosing the experiment budget. Prefer the smallest mode needed: model-only, Memory-only, Reflection-only, or the combined learning example. Do not enable Memory merely to test Reflection.

A model can return malformed edits, no-change, or time out. Follow [bounded recovery](validation-and-troubleshooting.md#bounded-recovery), retaining task-level attempt limits across experiment IDs. Do not claim activation or online use from a successful overall experiment alone: Reflection can be skipped/rejected while the Policy continues. Verify the module's status and later effect explicitly. A custom single-request Agent may be appropriate for a small fully inline structured-output task, but report that as a different backend; it does not establish `agent.pi` reliability.

## Observe the right Reflection layer

The complete learning and Reflection-only Policies retain each Reflection step output in `state.reflectionResults` and return it in the experiment output. Inspect `record.output.reflectionResults` for Runtime statuses such as `activated`. Memory variants also return their final `memoryRef`. Keep the selected candidate/measurement pair alongside these fields.

A raw generator receipt (the internal Reflection generator call, often binding `_reflection`) can return `{ status: 'proposed', proposal, reason }`. That is the generator contract, **not** the Runtime activation result. Do not assert that this raw output must equal `activated`. Link the Runtime step result's revisionRefs with the later proposer's call revisionRef and loaded guidance, then inspect its produced candidate and subsequent measurement. A revision fact labelled `validated` by itself is insufficient to show later use; the downstream evidence is required.
