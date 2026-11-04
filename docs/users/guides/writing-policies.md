# Write a Policy

English | [简体中文](writing-policies_zh.md) · [Getting started](../getting-started.md)

Policies use `rsi.policy/v1`; Recipes use `rsi.recipe/v1`. A Policy declares input, output, and configuration schemas, required contract IDs, optional default bindings, and its execution flow. See [Harness²](../../../src/policies/harness2/policy.yaml), [WikiSkill](../../../src/policies/wikiskill/policy.yaml), and the [Policy compiler](../../../src/runtime/compiler/).

| Construct | Behavior                                                                            |
| --------- | ----------------------------------------------------------------------------------- |
| `use`     | Call a required binding or the explicitly configured `reflection` module.           |
| `state`   | Persist state updates. Parallel branches cannot mutate shared state.                |
| `if`      | Execute conditional branches.                                                       |
| `foreach` | Iterate with stable unique keys, bounded concurrency, and optional `yield` results. |
| `loop`    | Run a nested loop. The top-level loop supports `maxIterations` and `while`.         |
| `control` | `break`, `continue`, or `fail` with a reason.                                       |

`init`, `loop`, and `finish` organize lifecycle stages. Expressions such as `${{ input.candidateRef }}` and `${{ loop.propose.output.candidateRef }}` connect data through the supported expression language and pure functions. They do not execute arbitrary JavaScript. Recipe paths and IDs must still be valid for the selected implementation.

A typical search flow initializes an incumbent and validation measurement, proposes a candidate, evaluates only changed candidates, selects by metrics, updates state on acceptance, and reports a final held-out measurement in `finish`. Reflection requires an explicit serial `use: reflection` step; do not place it in a parallel branch.

## Write a baseline evaluation Policy

Start with a single call. Save the Policy below as `my-extension/policy.yaml`. It takes the Application's initial candidate, calls AgentBench once, and returns the measurement reference. You can then move baseline measurement into `init` and add proposal, comparison, and acceptance steps to `loop`.

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
finish:
  steps:
    - id: evaluate
      use: evaluator
      with:
        candidateRef: ${{ input.candidateRef }}
        taskIds: ${{ config.taskIds }}
output:
  measurementRef: ${{ finish.evaluate.output.measurementRef }}
```

Keep the Application and Evaluator binding from [Getting started](../getting-started.md). Replace the whole Recipe `policy` section with `ref: policy.baseline-check` and `config: { taskIds: [terminal-bench/formal-crypto] }`. The Policy supplies the default initial-candidate input.

## Register a Policy

Register a custom Policy from a compiled extension (the paths below are relative to that extension module):

```js
import { fileURLToPath } from 'node:url';
import { readPolicy } from 'ember-rsi';

export async function register(registry) {
  const file = fileURLToPath(new URL('./policy.yaml', import.meta.url));
  const policy = await readPolicy(file, registry);
  registry.registerPolicy(String(policy.definition.id), file);
}
```

Register required plugin definitions before reading a Policy that uses their contracts. Reference the registered Policy ID in the Recipe and supply all required bindings. After source changes, use `pnpm build`; for engineering verification use the existing `pnpm check` entrypoint. Real model/benchmark experiments are separate from deterministic checks.
