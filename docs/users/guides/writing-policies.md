# Write a Policy

English | [简体中文](writing-policies_zh.md) · [Getting started](../getting-started.md)

This guide explains how to define a Policy's Schemas, required bindings, and execution steps and register it with Runtime for use by a Recipe.

Policies use `rsi.policy/v1`; Recipes use `rsi.recipe/v1`. A Policy declares input, output, and configuration schemas, required contract IDs, optional default bindings, and its execution flow. See [Harness²](../../../src/policies/harness2/policy.yaml), [WikiSkill](../../../src/policies/wikiskill/policy.yaml), and the [Policy compiler](../../../src/runtime/compiler/).

Every step declares `id` and `type` in one ordered top-level `steps` array. A Policy with shared state declares `state_schema` and initial `state`; initial expressions can use validated `input`, `application`, and `config`.

| Type         | Behavior                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `invoke`     | Call a binding declared in `require`, selected with `use`, and pass dynamic input through `with`.                               |
| `state`      | Validate and commit shared state updates atomically. Parallel branches cannot write shared state.                               |
| `if`         | Choose `then` or `else` blocks shaped as `{ steps, output? }`.                                                                  |
| `foreach`    | Iterate with stable unique `key` values, `as` for the item, optional `concurrency` (default 1), and optional per-item `output`. |
| `loop`       | Run `steps` with required `maxIterations`, optional `while`, and optional `output`.                                             |
| `control`    | Execute `break`, `continue`, or `fail` with a reason.                                                                           |
| `reflection` | Invoke the declared Reflection module serially.                                                                                 |

Expressions such as `${{ input.candidateRef }}` and `${{ steps.propose.output.candidateRef }}` occupy the whole scalar and connect data through a pure expression language; they do not execute arbitrary JavaScript. Completed steps resolve through lexical `steps` scopes, and `loop.index` is the nearest loop index. `maxIterations` must evaluate to an integer from 0 to 100,000. If/foreach output is evaluated in its local block; loop output is evaluated outside the loop. Retain per-round values in declared state if later steps need them, including the zero-round case. State-update expressions read the pre-update state.

A typical search measures a baseline, proposes and evaluates changed candidates in a loop, selects by metrics, saves accepted state, then evaluates held-out tasks through later ordinary steps. Parallel foreach branches return outputs for serial aggregation. Reflection uses `type: reflection` and cannot execute in a parallel branch. Bindings select plugins; there are no child Policies or fixed `init`/`finish` stages. Runtime owns cleanup on success, error, and cancellation.

## Write a baseline evaluation Policy

Start with a single call. Save the Policy below as `my-extension/policy.yaml`. It takes the Application's initial candidate, calls AgentBench once, and returns the measurement reference. Extend its `steps` array with proposal, comparison, and acceptance steps when needed.

```yaml
schemaVersion: rsi.policy/v1
id: policy.baseline-check
config_schema:
  type: object
  properties:
    taskIds:
      type: array
      minItems: 1
      items: { type: string, minLength: 1 }
  required: [taskIds]
  additionalProperties: false
input_schema:
  type: object
  properties:
    candidateRef: { type: string, minLength: 1 }
  required: [candidateRef]
  additionalProperties: false
output_schema:
  type: object
  properties:
    measurementRef: { type: string, minLength: 1 }
  required: [measurementRef]
  additionalProperties: false
input:
  candidateRef: ${{ application.initialCandidate }}
require:
  evaluator:
    contract: contract.agentbench
steps:
  - id: evaluate
    type: invoke
    use: evaluator
    with:
      candidateRef: ${{ input.candidateRef }}
      taskIds: ${{ config.taskIds }}
output:
  measurementRef: ${{ steps.evaluate.output.measurementRef }}
```

Keep the Application and Evaluator binding from [Getting started](../getting-started.md), and remove its other bindings: this Policy only declares `evaluator`. Replace the whole Recipe `policy` section with:

```yaml
policy:
  id: policy.baseline-check
  config:
    taskIds: [terminal-bench/formal-crypto]
```

The Policy supplies the default initial-candidate input. Register it before validating the Recipe.

## Register a Policy

Register a custom Policy from a compiled extension (the paths below are relative to that extension module):

```js
import { fileURLToPath } from 'node:url';
import { Policy } from 'ember-rsi';

export async function register(registry) {
  const file = fileURLToPath(new URL('./policy.yaml', import.meta.url));
  const policy = await Policy.load(file, registry);
  registry.registerPolicy(policy.id, file);
}
```

Register required plugin definitions before reading a Policy that uses their contracts. Reference the registered Policy ID in the Recipe and supply all required bindings. After source changes, use `pnpm build`; for engineering verification use the existing `pnpm check` entrypoint. Real model/benchmark experiments are separate from deterministic checks.

Place this registration module at `my-extension/index.mjs` and load it in each CLI process that needs the Policy:

```sh
ember-rsi validate my-experiment/recipe.yaml --plugin-dir ./my-extension
ember-rsi run my-experiment/recipe.yaml --id baseline-01 --plugin-dir ./my-extension
```

Creating a YAML file alone does not register it. See [extension loading](writing-plugins.md#register-an-external-extension-for-the-cli) and [experiment recovery](running-experiments.md#cancellation-and-resume) before changing a definition used by an unfinished experiment.
