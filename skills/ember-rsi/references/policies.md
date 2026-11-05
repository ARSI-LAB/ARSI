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
| `loop`       | Nested `steps` and optional `maxIterations`, `while`, and `output`.                                                                    |
| `foreach`    | Array `foreach`, item alias `as`, stable unique `key`, optional `concurrency`, `steps`, optional item `output`; collects in input order. |
| `control`    | `control: break`, `continue`, or `fail`; `fail` requires a string `reason`.                                                              |
| `reflection` | Invokes the configured Reflection module serially; accepts no per-call binding/configuration override.                                   |

Use `steps.<id>.output` for a completed visible step. Expression roots are `application`, `config`, `input`, `state`, `steps`, the nearest `loop.index`, and current foreach aliases. There are no `init` or `finish` scopes. Blocks resolve names lexically; a local declaration shadows the outer name even before completion, so it cannot fall back to an outer result. Branch/item outputs stay local unless explicitly returned with `output` and read through the enclosing step.

If/foreach output templates run in their local block after normal completion. Loop output runs in the outer scope after the loop, including zero iterations; retain per-round values in declared state when they are needed afterward. State updates evaluate all right-hand sides against the pre-update state. Parallel foreach branches cannot write shared state: return item results and aggregate in a later serial step. Validate stable keys unique across the complete input array before any item effects. Control results skip pending block output and propagate to the relevant loop boundary; `break`/`continue` cannot cross a foreach boundary to control an outer loop.

All top-level steps run in order. Reporting and held-out evaluation use ordinary later steps. There is no report phase or finally block; plugin and Runtime lifecycles own cleanup after success, failure and cancellation. New execution checkpoints lock definition/input identity. Earlier DSL checkpoints are unsupported for resumption.

## Expressions and limits

Only a complete scalar `${{ expression }}` is evaluated; `round-${{ loop.index }}` is invalid. Templates recursively evaluate array/object values, preserving types; keys are not expressions.

Arithmetic requires finite numbers, `+` is numeric addition, and conditions require booleans. Missing properties/indexes throw; `get(value, key, fallback)` supplies an eagerly evaluated fallback for missing values, while an existing null remains null.

The closed function set is `get`, `length`, `size`, `flatten`, `append`, `concat`, `pluck`, `range`, `some`, `if`, and `compact`. `length`/`size` take arrays; `compact` removes nulls. `if(condition, yes, no)` and the ternary evaluate only the selected branch. Build objects and arrays in YAML.

Do not use optional chaining, `??`, arbitrary methods, JavaScript `eval`, or `coalesce`. There are no `try`, `catch`, `finally`, `retry`, `onError`, `shell`, `http`, or `parallel` step types. Use foreach for bounded concurrency and provider-owned handling for external errors. A loop does not authorize repeating an effect with an unknown outcome.

Omit `maxIterations` or set it to `null` to leave the iteration count unrestricted. An explicit bound must be a nonnegative safe integer. `foreach` runs serially by default and accepts a positive safe integer for `concurrency`. `range` accepts ordered safe-integer endpoints. Expression size and token bounds still apply, and configured Recipe budgets may stop execution. YAML aliases and duplicate keys are unsupported. Account for checkpoint I/O and inspect outcomes after a host command timeout.

## Defaults, loading and schemas

Put reusable plugin declarations under `defaults.bindings` and Reflection under `defaults.reflection.configFile`. Every default needs a `require` entry. Bindings select plugins only; there are no child Policies or nested binding maps. Reuse flow through ordinary nested steps.

Use `Policy.load(path, registry)` from `ember-rsi` for file-backed Policies. It expands supported local-file `$ref` schemas relative to the declaring files, resolves contracts and validates steps. `$ref` must be the only field at that position; remote and fragment-only references are unsupported. `compilePolicy(value, { directory, contracts: registry })` compiles already loaded data. The loaded Policy exposes `id`, `inputSchema`, `configSchema`, `stateSchema`, `outputSchema`, `requirements`, `defaults`, `steps`, and `toJSON()`.

Use `Recipe.load(path, registry)` for assembled experiment definitions. Its Application and plugin bindings are validated `Binding` objects with `pluginId` and `config`; `Binding.toJSON()` serializes `{ plugin, config }`. Loading does not initialize the Application or run models.
