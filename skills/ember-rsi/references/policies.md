# Write a Policy

A Policy defines an algorithm over declared plugin operations. Use [Recipes](recipes.md) to select implementations and task parameters. Read each public contract before constructing a call's `with` input.

## Authoring sequence

1. Define input, output, configuration, state and termination conditions.
2. Declare `require` entries by registered contract ID and reusable plugin defaults under `defaults.bindings`.
3. Declare `state_schema` and initialize every shared state field in top-level `state`.
4. Express the algorithm as one ordered `steps` array with explicit step types.
5. Register required plugins and the Policy ID/path, then load and validate using that Registry.

Policies use `rsi.policy/v1`. `input_schema` must describe an object; `steps`, `output_schema` and `output` are required. `config_schema` describes algorithm configuration. `input` optionally supplies missing input fields from `application` and `config`; explicit Recipe input fields win. Initial `state` may use `application`, `config` and validated `input`, before any steps run. `require` is a mapping of binding names to contract IDs.

## Complete runnable Policy

Use [policy.yaml](../assets/minimal/policy.yaml) with its complete [Recipe](../assets/minimal/recipe.yaml) and extension registration. It measures the baseline, keeps the candidate/measurement pair in declared state, proposes in a bounded loop, evaluates only created candidates and retains the selector's paired output. A second fixed proposal returns no-change; zero rounds return the measured baseline. Follow [quickstart](quickstart.md) for all execution assets.

The Policy explicitly maps `input.candidateRef` from `${{ application.initialCandidate }}`. Explicit Recipe input overrides that mapping. [learning.yaml](../assets/learning/learning.yaml) adds Memory and Reflection; copy and register its optional resources as described in [advanced capabilities](advanced.md).

## Steps, scopes and output

Every step has a safe `id`, unique within its block, and an explicit `type`:

| Type         | Shape and effect                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke`     | `use: binding`, optional `with: <input>`; calls a required plugin binding.                                                               |
| `state`      | `state: { field: value }`; atomically validates and commits the updated full state.                                                      |
| `if`         | Boolean `if`, `then: { steps, output? }`, optional `else` with the same shape.                                                           |
| `loop`       | `maxIterations`, optional `while`, nested `steps`, optional `output`.                                                                    |
| `foreach`    | Array `foreach`, item alias `as`, stable unique `key`, optional `concurrency`, `steps`, optional item `output`; collects in input order. |
| `control`    | `control: break`, `continue`, or `fail`; `fail` requires a string `reason`.                                                              |
| `reflection` | Invokes the configured Reflection module serially; accepts no per-call binding/configuration override.                                   |

Use `steps.<id>.output` for a completed visible step. Expression roots are `application`, `config`, `input`, `state`, the nearest `loop.index`, and current foreach aliases. There are no `init` or `finish` scopes. Blocks resolve names lexically; a local declaration shadows the outer name even before completion, so it cannot fall back to an outer result. Branch/item outputs stay local unless explicitly returned with `output` and read through the enclosing step.

If/foreach output templates run in their local block after normal completion. Loop output runs in the outer scope after the loop, including zero iterations; retain per-round values in declared state when they are needed afterward. State updates evaluate all right-hand sides against the pre-update state. Parallel foreach branches cannot write shared state: return item results and aggregate in a later serial step. Validate stable keys unique across the complete input array before any item effects. Control results skip pending block output and propagate to the relevant loop boundary; `break`/`continue` cannot cross a foreach boundary to control an outer loop.

All top-level steps run in order. Reporting and held-out evaluation use ordinary later steps. There is no report phase or finally block; plugin and Runtime lifecycles own cleanup after success, failure and cancellation. New execution checkpoints lock definition/input identity. Earlier DSL checkpoints are unsupported for resumption.

## Expressions and limits

Only a complete scalar `${{ expression }}` is evaluated; `round-${{ loop.index }}` is invalid. Templates recursively evaluate array/object values, preserving types; keys are not expressions.

Arithmetic requires finite numbers, `+` is numeric addition, and conditions require booleans. Missing properties/indexes throw; `get(value, key, fallback)` supplies an eagerly evaluated fallback for missing values, while an existing null remains null.

The closed function set is `get`, `length`, `size`, `flatten`, `append`, `concat`, `pluck`, `range`, `some`, `if`, and `compact`. `length`/`size` take arrays; `compact` removes nulls. `if(condition, yes, no)` and the ternary evaluate only the selected branch. Build objects and arrays in YAML.

Do not use optional chaining, `??`, arbitrary methods, JavaScript `eval`, or `coalesce`. There are no `try`, `catch`, `finally`, `retry`, `onError`, `shell`, `http`, or `parallel` step types. Use foreach for bounded concurrency and provider-owned handling for external errors. A loop does not authorize repeating an effect with an unknown outcome.

`maxIterations` is required and must evaluate to an integer from 0 to 100,000. `foreach` runs serially by default and accepts a positive safe integer for `concurrency`. `range` accepts ordered safe-integer endpoints. Expression size and token bounds still apply, and configured Recipe budgets may stop execution. YAML aliases and duplicate keys are unsupported. Account for checkpoint I/O and inspect outcomes after a host command timeout.

## Terminal limits and per-strategy eligibility

A configured limit such as `maxRounds` is a hard boundary for every later step, strategy and side effect, so check it **before** starting the work that would consume the round rather than after that work succeeds. Once the final permitted round is consumed, no further proposal, evaluation or other effect may begin, including one initiated by a different strategy. Keep the reported completed-round count consistent with admitted transitions and never above the configured maximum. A rejected transitional step may still consume a round; cover the final round under accepted mutation, accepted crossover and rejected crossover outcomes.

Counted budgets are boundaries too, and each is denominated in its own unit. A round limit, a framework evaluation-run count and a per-instance rollout allowance are different quantities even when one evaluation spends several of them; keep each allowance in the unit the requirement names instead of reinterpreting it through another counter. Expose the per-instance allowance in configuration and compare the remaining amount **before** the effect that spends it, rather than reporting usage after execution. A batch spends one unit per instance: initial selection scoring, parallel parent/proposal evaluation and a multi-instance crossover must each check the remainder for the whole batch and shrink or stop before the excess rather than silently overrunning it. Preserve each existing framework budget's meaning and add a separate limit when the requirement uses a different unit; cover a small allowance together with a batch that would otherwise exceed it.

Strategies may legitimately draw from different sets, so derive each eligibility pool separately instead of reusing one filter. Mutation can sample instance winners; crossover eligibility instead follows from the population/ancestry relation and complementary changes, so a nondominated or balanced source that wins no individual instance can still be a valid parent. Make each pool explicit and cover a counterexample: complementary specialists plus a diluted balanced source must stay crossover-eligible, and adding an unrelated specialist must not remove that pair. Name the pool a selection step uses so a later reader can check it against the stated requirement.

Lineage is not the workspace base. When a crossover is admitted, persist both genetic source parents together with the mixed candidate's inherited ancestry; the Application's common-ancestor workspace says where edits are applied, not who the parents were, so recording only `merged -> base` loses the relation. Ancestry-based eligibility must then exclude direct and transitive ancestor/descendant pairs in both directions, so a source is never offered as a partner to its own child or grandchild. Exercise a successful crossover followed by a later crossover decision through the real public step and state boundary, not only a hand-built single-parent chain. A mixed candidate's admission baseline is its genetic source parents, not their common ancestor or the workspace base used to construct the merge. Compare it with both parents on the same comparison instances and reject a merge that is worse than either parent even when the shared ancestor scores much lower.

Module rotation is not round advancement. When reflective mutation rotates through editable modules, keep the cursor in declared state and advance it only when a mutation actually selects a module. A crossover combines modules and selects none, so an admitted or rejected crossover must leave the cursor unchanged; with modules `a`, `b` and strategies mutation, mutation, crossover, mutation the reflected modules are `a`, `b`, `a`, not `a`, `b`, `b`. Cover such a sequence through the public step/state boundary, retaining the configured round limit and leaving nonselected module contents untouched.

## Observed values and logical iteration identity

Selection and admission compare observed evidence, not placeholders. An evaluation whose status is unavailable, failed or of unknown coverage is not a zero score: keep it out of the pools used to pick a winner or to admit a candidate, and keep its failed/unknown meaning for reporting. A successful measurement reporting a scalar `0` is a real value that may win or be admitted. When the baseline or initial evaluation is unavailable, the run has no admission threshold at all rather than a zero threshold; surface that gap instead of comparing against zero.

Calls are deduplicated by identity, so a repeated identity returns the earlier receipt instead of executing again. Give every logical iteration its own identity — for example the round or attempt number carried in the request — so that a rejected proposal with an unchanged parent, module and minibatch does not suppress the next reflection attempt, while a genuine retry of one identified call keeps reuse. Report actual execution separately from reused results: count only newly executed proposals and rollouts, and do not present a replayed receipt as a new round's evidence.

A reflective revision of a sampled attempt must receive the attempt itself, not only its grade. Forward the task input, the observable Agent output and the relevant rollout trajectory together with the current prompt, score and evaluator feedback, read through the authorized execution view and kept associated with the task and module they came from. When that execution record is unavailable, keep the gap explicit in the request rather than substituting summaries, and describe only examples the request actually contains. Verify the composed request or the input delivered through the public path, not the meta-prompt's wording.

## Defaults, loading and schemas

Put reusable plugin declarations under `defaults.bindings` and Reflection under `defaults.reflection.configFile`. Every default needs a `require` entry. Bindings select plugins only; there are no child Policies or nested binding maps. Reuse flow through ordinary nested steps.

Use `Policy.load(path, registry)` from `ember-rsi` for file-backed Policies. It expands supported local-file `$ref` schemas relative to the declaring files, resolves contracts and validates steps. `$ref` must be the only field at that position; remote and fragment-only references are unsupported. `new Policy(value, { directory, contracts: registry })` compiles already loaded data. The loaded Policy exposes `id`, `inputSchema`, `configSchema`, `stateSchema`, `outputSchema`, `requirements`, `defaults`, `steps`, and `toJSON()`.

Use `Recipe.load(path, registry)` for assembled experiment definitions. Its Application and plugin bindings are validated `Binding` objects with `pluginId` and `config`; `Binding.toJSON()` serializes `{ plugin, config }`. Loading does not initialize the Application or run models.
