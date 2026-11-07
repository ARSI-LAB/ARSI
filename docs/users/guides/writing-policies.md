# Write a Policy

English | [简体中文](writing-policies_zh.md) · [Getting started](../getting-started.md)

This guide explains how to define a Policy's fields and execution steps, register it, and use it in a Recipe.

**A Policy decides the order of plugin calls, which branches to take, and when execution ends.**

## What a Policy file contains

Policies use `rsi.policy/v1` with `rsi.recipe/v1` Recipes. The main fields are:

| Field                 | Purpose                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`       | Specify the Policy format; currently only `rsi.policy/v1` is supported.                                                         |
| `id`                  | Registered Policy ID, selected by the Recipe's `policy.id`.                                                                     |
| `description`         | Optional prose describing the flow's purpose.                                                                                   |
| `config_schema`       | Define flow parameters and their types, supplied through the Recipe's `policy.config`, such as task lists or iteration limits.  |
| `input_schema`        | Define the data needed to start the flow, supplied through the Recipe's `policy.input`, such as an initial candidate reference. |
| `input`               | Supply input defaults, which can reference the Application's initial candidate.                                                 |
| `require`             | Declare binding names and their public contracts, such as `evaluator` requiring `contract.agentbench`.                          |
| `defaults.bindings`   | Supply default plugins and configuration that the Recipe can override.                                                          |
| `defaults.reflection` | Select a Reflection configuration file through `configFile`; required when the flow uses a `reflection` step.                   |
| `state_schema`        | Define shared-state fields and types when the flow needs state.                                                                 |
| `state`               | Set initial shared-state values; expressions can read `input`, `application`, and `config`.                                     |
| `steps`               | Ordered execution steps, each declaring `id` and `type`.                                                                        |
| `output_schema`       | Define the structure of the Policy's final result.                                                                              |
| `output`              | Select return values from step outputs or shared state.                                                                         |

## Steps and data flow

### Step types

List steps in execution order under `steps`. Each step declares `id` and `type`, followed by the parameters below:

| Type         | Purpose                                                    | How to write it                                                                                                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke`     | Call a plugin to perform one task.                         | Set `use` to a binding name from `require` and supply the call's input through `with`.                                                                                                                                                                                 |
| `state`      | Save shared state for later steps or iterations.           | Set `state` to the fields and values to update, using expressions as needed; validate and commit the whole update together. Requires serial execution.                                                                                                                 |
| `if`         | Choose a branch based on a condition.                      | Supply the condition in `if`, a required `then` block, and an optional `else` block. Each branch contains `steps` and optional `output`.                                                                                                                               |
| `foreach`    | Process each item in a collection, optionally in parallel. | Set `foreach` to the collection, `as` to the item name, `key` to a stable unique identity, and `steps` to each item's operations. `concurrency` limits how many items are processed at once and defaults to 1 (serial execution); `output` returns each item's result. |
| `loop`       | Repeat a sequence of steps.                                | Supply the loop body in `steps` and required `maxIterations`, evaluating to an integer from 0 to 100,000. Optionally use `while` to end the loop early and `output` to define its return value.                                                                        |
| `control`    | Exit a loop, skip the current iteration, or end the flow.  | Set `control` to `break`, `continue`, or `fail`; `fail` also requires `reason`.                                                                                                                                                                                        |
| `reflection` | Use the built-in Reflection capability for self-evolution. | Set the step's `type: reflection` and declare the module in `defaults.reflection`. Requires serial execution; see the [Reflection guide](reflection.md) for configuration.                                                                                             |

### Read data with expressions

Use field names from the relevant Schema and step IDs declared by the Policy. For example:

```yaml
taskIds: ${{ config.taskIds }} # Configured task list
candidateRef: ${{ input.candidateRef }} # Candidate from startup input
measurementRef: ${{ steps.evaluate.output.measurementRef }} # Output of the evaluate step
bestCandidateRef: ${{ state.bestCandidateRef }} # Current shared state
```

- Expressions occupy the entire field value. `steps` can reference completed steps in the current or enclosing block.
- `application.initialCandidate` and `loop.index` are fixed framework properties.

### Shared state and parallel execution

- Declare fields with `state_schema`, initialize them with `state`, and update them through `state` steps. Every expression in one update reads the state before that update.
- Parallel `foreach` branches return results through their own `output`; later serial steps aggregate them and update shared state. Shared-state updates and Reflection steps require serial execution.
  - `if` and `foreach` outputs are evaluated inside their blocks; a `loop` output is evaluated after the loop ends.
  - Save loop-local data that must be retained in shared state, and initialize values for the zero-iteration case.

## Write a baseline evaluation Policy

The following Policy receives a candidate and task list, calls the Evaluator once, and returns a measurement reference. Choose where to save the file according to the registration method in the next section.

```yaml
# Protocol version used by this Policy file.
schemaVersion: rsi.policy/v1
# Registered Policy ID, selected through the Recipe's policy.id.
id: policy.baseline-check

# Define flow parameters supplied through the Recipe's policy.config; require a task list here.
config_schema:
  type: object
  properties:
    taskIds:
      type: array
      minItems: 1
      items: { type: string, minLength: 1 }
  required: [taskIds]
  additionalProperties: false

# Define startup input: the candidate reference to evaluate.
input_schema:
  type: object
  properties:
    candidateRef: { type: string, minLength: 1 }
  required: [candidateRef]
  additionalProperties: false

# Define the final Policy result: the measurement reference produced by evaluation.
output_schema:
  type: object
  properties:
    measurementRef: { type: string, minLength: 1 }
  required: [measurementRef]
  additionalProperties: false

# Default to evaluating the candidate created during Application initialization.
input:
  candidateRef: ${{ application.initialCandidate }}

# Declare the evaluation contract required by the evaluator binding.
require:
  evaluator:
    contract: contract.agentbench

# Default evaluation plugin and 3600-second task timeout; the Recipe can override both.
defaults:
  bindings:
    evaluator:
      plugin: evaluator.agentbench
      config:
        run:
          timeoutSeconds: 3600

# Evaluate once, passing the input candidate and configured task list to evaluator.
steps:
  - id: evaluate
    type: invoke
    use: evaluator
    with:
      candidateRef: ${{ input.candidateRef }}
      taskIds: ${{ config.taskIds }}

# Return the measurement reference produced by the evaluate step.
output:
  measurementRef: ${{ steps.evaluate.output.measurementRef }}
```

## Register a Policy

A Recipe resolves a Policy file by its registered ID. Built-in Policies are already registered by the framework and ready to use. Choose one of these methods to register a new Policy:

| Method               | When to use it                                                                     |
| -------------------- | ---------------------------------------------------------------------------------- |
| Modify the source    | Modify RSI source to build and provide the new Policy with the framework.          |
| Load through the CLI | Keep the Policy in your own extension directory and load it with an installed CLI. |

- If the Policy uses a custom contract, both methods require registering the corresponding plugin definition before loading the Policy.

### Method 1: Modify the source

1. Save the example above as `src/policies/baseline-check/policy.yaml`.
2. Find the Policy file list in `registerBuiltins` in the [built-in registration file](../../../src/runtime/builtins.ts) and add `'baseline-check/policy.yaml'`. The existing loop reads the file's `id` and registers the Policy.
3. Run `pnpm build` from the repository root to update the CLI and Policy files. Then validate and run through the repository's `pnpm ember-rsi` command, as shown in the shared steps below.

### Method 2: Load through the CLI (dynamic loading at startup)

1. Save the example above as `my-extension/policy.yaml`.

2. Create `index.mjs` beside it, exporting `register(registry)`. The CLI calls this function when loading the extension:

   ```js
   import { fileURLToPath } from 'node:url';
   import { Policy } from 'ember-rsi';

   export async function register(registry) {
     const file = fileURLToPath(new URL('./policy.yaml', import.meta.url));
     const policy = await Policy.load(file, registry);
     registry.registerPolicy(policy.id, file);
   }
   ```

3. Pass `--plugin-dir ./my-extension` when validating and running to load the registration entrypoint.
   - One entrypoint can register multiple Policies; if one already exists, add the code to its existing `register` function.

### Configure the Recipe and run

#### Step 1: Select the Policy in the Recipe

Keep the Application from [Getting started](../getting-started.md) and retain only `evaluator` under the Recipe's `bindings`.

Replace the whole Recipe `policy` section with:

```yaml
policy:
  id: policy.baseline-check
  config:
    taskIds: [terminal-bench/formal-crypto]
```

The example Policy's `input` already defaults to the Application's initial candidate, so the Recipe can omit `policy.input` here.

#### Step 2: Validate and run

**After modifying the source**, use the newly built CLI from the repository root:

```sh
pnpm ember-rsi validate my-experiment/recipe.yaml
pnpm ember-rsi run my-experiment/recipe.yaml --id baseline-01
```

**When loading through the CLI**, run from the working directory containing `my-extension/` and `my-experiment/`, loading the same extension in both commands:

```sh
ember-rsi validate my-experiment/recipe.yaml --plugin-dir ./my-extension
ember-rsi run my-experiment/recipe.yaml --id baseline-01 --plugin-dir ./my-extension
```

See [extension registration](writing-plugins.md#method-2-register-an-external-extension-for-the-cli) for other loading options. Before changing a Policy used by an unfinished experiment, check the [recovery requirements](running-experiments.md#cancellation-and-resume).
