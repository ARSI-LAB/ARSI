# Write a Policy

A Policy defines an algorithm over declared operations. Use [Recipes](recipes.md) to bind implementations and set task parameters. Read actual contract schemas before constructing a call's `with` input.

## Authoring sequence

1. Define the Policy's input, output, configuration and termination conditions.
2. Declare `require` entries by registered contract ID; choose defaults only where a reusable implementation/configuration is appropriate.
3. Initialize persistent state before any path reads it.
4. Express calls, branching and iteration with the supported DSL.
5. Load/compile with the intended Registry, register the Policy ID and path, then validate a concrete Recipe against that host.

Policies use `rsi.policy/v1`. `input_schema` must describe an object, and `output_schema` and `output` are required. `config_schema` describes algorithm configuration; `input` optionally maps missing input properties from `application` and `config`. The Recipe's explicit input properties win. `require` is a mapping, not an array of schema filenames.

## Complete runnable Policy

Use [policy.yaml](../assets/minimal/policy.yaml) with its complete [Recipe](../assets/minimal/recipe.yaml) and extension registration. It measures the baseline in init, keeps candidate/measurement in state, proposes in a bounded loop, evaluates only created candidates and retains the selector's paired output. A second fixed proposal returns no-change; zero rounds return the measured baseline. All assets needed to execute it are in [quickstart](quickstart.md).

Do not assume `input.candidateRef` is auto-populated: the included `input` mapping explicitly sets it from `${{ application.initialCandidate }}`. Explicit Recipe input overrides that mapping. [learning.yaml](../assets/learning/learning.yaml) adds Memory state and explicit Reflection to the same flow; copy and register its optional resources as described in [advanced capabilities](advanced.md).

## Steps, scopes and output

Every step has a unique safe `id` within its step list and exactly one kind:

| Kind      | Shape and effect                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `use`     | `use: binding`, `with: <input>`; calls a declared dependency, exposes `<phase>.<id>.output`                              |
| `state`   | `state: { field: value }`; evaluates a patch and updates persistent state                                                |
| `if`      | Boolean `if`, required `then`, optional `else`; branches can be step arrays or `{ steps, yield }`                        |
| `foreach` | Array `foreach`, item alias `as`, stable unique `key`, optional `concurrency`, `steps`, `yield`; collects in input order |
| `loop`    | Nested `loop: { maxIterations, while?, steps, output? }` and optional step-level `input`                                 |
| `control` | `break`, `continue`, or `fail`; only `fail` takes a required nonempty reason                                             |

`init.steps` runs once, the root `loop` performs bounded iterations, and `finish.steps` runs after normal flow, including a root-loop break. `finish` is not a `finally` block for errors or cancellation; plugin/Runtime lifecycles own cleanup.

Expression roots are `application`, `config`, `input`, `state`, `init`, `loop`, `finish`, plus the current `foreach` alias. There is no public `ember-rsi` or `dependencies` expression root in this revision. Use `loop.index` for the current lexical iteration. Initialize any state needed after a loop before entering it, since the loop may run zero times. State-patch right-hand sides see the pre-patch state.

Inside a phase, completed step outputs are available through that phase's frame. Branch-local outputs do not become sibling outputs automatically; return a branch `yield` and consume the enclosing step's `.output`. Concurrent `foreach` branches cannot write shared state: yield branch results and aggregate afterward. Use deterministic keys unique in the input array, not timestamps/random values. `break`/`continue` cannot cross a `foreach` or Policy boundary to control an outer loop.

## Expressions and limits

Only an entire string of the form `${{ expression }}` is evaluated. `round-${{ loop.index }}` is rejected with `Expression must occupy complete scalar`; there is no string interpolation. Templates recursively evaluate values in YAML arrays/objects, preserving types; keys are not expressions.

Supported arithmetic/comparison/logical operators and ternaries are deliberately bounded. Arithmetic requires finite numbers, `+` is numeric addition, and logical conditions require booleans. Missing properties/indexes throw; use `get(value, key, fallback)` for optional data. Its fallback is evaluated eagerly, and an existing `null` is not missing.

The closed function set is `get`, `length`, `size`, `flatten`, `append`, `concat`, `pluck`, `range`, `some`, `if`, and `compact`. `length`/`size` take arrays; `compact` removes nulls. `if(condition, yes, no)` and the ternary evaluate only the selected branch. Build objects/arrays in YAML instead of JavaScript literals inside expressions.

Do not use optional chaining, `??`, arbitrary methods, JavaScript `eval`, or `coalesce`. There are no `try`, `catch`, `finally`, `retry`, `onError`, `shell`, `http`, `parallel`, or inline `reflection` step kinds. Use `foreach` for concurrency and provider-owned error handling for external operations. A loop is not authorization to repeat an effect whose outcome is unknown.

Runtime limits include 100000 loop iterations, 10000 foreach/range items, foreach concurrency 1–64, and expression size/token bounds. Actual Recipe budgets may stop work sooner. YAML aliases and duplicate keys are unsupported.

These are safety limits, not recommended workloads. Policy steps persist checkpoints, so budget for checkpoint I/O as well as external calls. A host command timeout leaves the experiment outcome unknown until inspected.

## Defaults, sub-Policies and schemas

Put reusable binding configuration in `defaults.bindings` and the Reflection module in `defaults.reflection.configFile`. Each default binding must have a corresponding `require` entry. Override them from a Recipe as described in [Recipes](recipes.md#bindings-and-defaults).

A binding may select a registered child Policy instead of an operation when the child's input/output schemas match the required contract. Register the contract before compiling the parent. The child has its own state, input, config and defaults; provide child overrides through the binding's nested `bindings` map. A child file is not discovered automatically.

Use `readPolicy(path, registry)` for file-backed policies: it expands supported local-file `$ref` schema documents relative to their declaring files, then compiles. A `$ref` must be the sole field at that location; remote and fragment-only references are not supported by this loader. `compilePolicy(value, { directory, contracts: registry })` takes already loaded data and does not perform file expansion.
