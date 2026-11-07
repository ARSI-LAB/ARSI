# Write a plugin

English | [简体中文](writing-plugins_zh.md) · [Getting started](../getting-started.md)

This guide explains how to choose a plugin contract, define configuration, implement business logic, register the plugin, and use it in Policies and Recipes.

**Plugins provide concrete capabilities, Policies decide when to call them, and Recipes select implementations and supply configuration.** For changes to models, tasks, or prompts, start with [Configuration](configuration.md); for changes to execution steps, see [Write a Policy](writing-policies.md). Consider writing a custom plugin when those options do not meet your needs.

## Choose a public contract

Choose a contract based on the work your plugin will do. The contract defines the call's input and output; the plugin supplies the implementation and its configuration. When an existing contract meets your needs, reuse its object and types:

| Contract and field definitions                                                                         | Purpose                                                                                      | Contract object to import         |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------- |
| [contract.application](../../../src/contracts/plugin-types/application.ts)                             | Manage optimization targets, commit candidates, and acquire and release execution instances. | `applicationContract`             |
| [contract.agent](../../../src/contracts/plugin-types/agent.ts)                                         | Run model requests and tool calls.                                                           | `agentContract`                   |
| [contract.proposer](../../../src/contracts/plugin-types/proposer.ts)                                   | Generate candidates from goals and evidence.                                                 | `proposerContract`                |
| [contract.proposer-operator](../../../src/contracts/plugin-types/proposer-operator.ts)                 | Modify and repair operators and summarize optimization history.                              | `operatorProposerContract`        |
| [contract.agentbench](../../../src/contracts/plugin-types/agentbench.ts)                               | Evaluate candidates against a task list.                                                     | `agentbenchContract`              |
| [contract.inferencebench](../../../src/contracts/plugin-types/inferencebench.ts)                       | Evaluate inference application candidates.                                                   | `inferencebenchContract`          |
| [contract.operatorbench](../../../src/contracts/plugin-types/operatorbench.ts)                         | Check operator correctness, measure performance, or collect profiling data.                  | `operatorbenchContract`           |
| [contract.selector-metrics](../../../src/contracts/plugin-types/selector-metrics.ts)                   | Compare measurement metrics and select a candidate.                                          | `metricSelectorContract`          |
| [contract.selector-artifacts](../../../src/contracts/plugin-types/selector-artifacts.ts)               | Compare candidate content against supplied criteria and select a candidate.                  | `artifactSelectorContract`        |
| [contract.memory](../../../src/contracts/plugin-types/memory.ts)                                       | Consolidate evidence and observations into reusable experience.                              | `memoryContract`                  |
| [contract.reflection](../../../src/contracts/plugin-types/reflection.ts)                               | Propose plugin revisions based on execution evidence.                                        | `reflectionContract`              |
| [contract.proposer-grid](../../../src/contracts/plugin-types/proposer-grid.ts)                         | Generate parameter candidates in grid-search order.                                          | `gridProposerContract`            |
| [contract.proposer-parameter-search](../../../src/contracts/plugin-types/proposer-parameter-search.ts) | Manage search state, suggest parameters, and receive evaluation feedback.                    | `parameterSearchProposerContract` |

Each regular plugin implements one public contract. Contracts such as Application include multiple actions, handled by the same `execute` according to `input.action`.

- The linked definition files contain input/output types and Schemas. The plugin only declares its own configuration Schema.

The Policy's `require` specifies the contract, and the binding selects a plugin that satisfies it. This lets the same Policy use different implementations; see [Contract, Schema, and Binding](../concepts/architecture.md#contract-schema-and-binding) for the concepts.

## What a plugin definition contains

`OperationDefinition<I, O, C>` describes a plugin definition. Its three type parameters are input, output, and configuration; see the [interface definition](../../../src/contracts/operation.ts).

| Field                  | Meaning                                                             | How to fill it in                                                                                   |
| ---------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `id`                   | Unique plugin implementation ID used by bindings.                   | Required, for example `proposer.keep-parent`; must not duplicate a registered plugin or Policy ID.  |
| `description`          | Describe the plugin's purpose.                                      | Optional short description.                                                                         |
| `contract`             | Declare the public contract the plugin follows.                     | Required imported contract object, such as `proposerContract`.                                      |
| `configSchema`         | Validate this implementation's configuration.                       | Required JSON Schema; declare an object Schema even when there are no settings.                     |
| `create`               | Create a plugin instance from configuration.                        | Required async function `create(config, context)` returning an object with `execute` and `dispose`. |
| `implementationDigest` | Identify the implementation version so recovery can detect changes. | Optional digest covering the actual implementation code; update it when the code changes.           |

- Without `implementationDigest`, Registry generates a digest from the `create` function text, contract, and configuration Schema.

### configSchema

**`configSchema` defines the settings a plugin accepts and the rules for supplying them.** Plugin authors specify field names, types, required fields, and defaults; users supply actual values in the Policy or Recipe's `config`.

- For example, the plugin below requires `reason` to be a nonempty string. A user can supply `config: { reason: 'Keep the parent candidate.' }`. If `reason` is missing or is a number, Runtime reports a configuration error when loading the Recipe. After validation, the plugin reads `config.reason` through `create(config, context)`.

The table lists common rule fields used when writing `configSchema`:

| Schema field                         | Meaning                                                                          | Example syntax                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `type`                               | Specify the value's type.                                                        | `type: 'object'`; use `type: ['string', 'null']` to allow null.                    |
| `properties`                         | Define an object's fields and their types.                                       | `properties: { reason: { type: 'string' } }`.                                      |
| `required`                           | Specify fields that must be supplied.                                            | `required: ['reason']`; listing a field in `properties` does not make it required. |
| `additionalProperties`               | Control whether undeclared fields are allowed.                                   | Usually `false`, so misspelled or unknown fields fail validation.                  |
| `default`                            | Fill in an omitted field.                                                        | `default: 1`; the value must match the field's type.                               |
| `enum` / `const`                     | Restrict values to a set or one fixed value.                                     | `enum: ['maximize', 'minimize']` / `const: 'retain-incumbent'`.                    |
| `minimum` / `maximum`                | Set numeric bounds.                                                              | `type: 'integer', minimum: 1`.                                                     |
| `minLength` / `pattern`              | Restrict string length or format.                                                | `type: 'string', minLength: 1`.                                                    |
| `items` / `minItems` / `uniqueItems` | Specify array element types, minimum length, and whether duplicates are allowed. | `items: { type: 'string' }, minItems: 1, uniqueItems: true`.                       |
| `oneOf`                              | Define structures where exactly one must match.                                  | An array of Schemas, often used to distinguish inputs and outputs by `action`.     |
| `x-rsi-path`                         | Mark a configuration field as a file or directory path.                          | Set `'x-rsi-path': 'file'` or `'directory'` on a string field.                     |

Runtime merges Policy and Recipe configuration, fills defaults, validates it, and passes the result to `create`.

- Relative paths marked with `x-rsi-path` are resolved against the file declaring the configuration.

- Plugins can also support reading configuration from environment variables. For example, `agent.pi` accepts the following `api_key` setting:

  ```yaml
  # agent.pi config excerpt
  api_key: ${MODEL_API_KEY}
  ```

  Set `export MODEL_API_KEY='your-api-key'` before starting the CLI, and `agent.pi` reads that variable as the key at runtime. Custom plugins must implement environment-variable reading to support this syntax; declaring `type: 'string'` in the Schema only checks the field's type.

### The object returned by create

The `create(config, context)` function in the table initializes the plugin with validated configuration and returns an object called a **plugin instance**.

Runtime executes this object's `execute(input, context)` for each plugin call. It can reuse the same object and calls `dispose()` to release resources when the instance is no longer needed. The methods have the following responsibilities:

| Method                              | Purpose                                                                                   | How to write it                                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `execute(input, context)`           | Perform one business call.                                                                | Required; asynchronously return output matching the public contract. `input` contains the data for this call.                             |
| `dispose()`                         | Release instance-owned processes, connections, listeners, and other long-lived resources. | Required; complete cleanup asynchronously. May be empty when there are no resources.                                                      |
| `canRetry(input, receipt, context)` | Confirm whether a failed or cancelled call can be replayed safely.                        | Optional; return `true` only after read-only checks confirm replay cannot duplicate effects. Does not replay calls with unknown outcomes. |

## Example: Write and use a minimal Proposer

This plugin always keeps the parent candidate to verify registration and calls. It does not need a model.

- It uses the three required inputs of `contract.proposer`: `parent` is the parent candidate reference, `goal` is the current goal, and `evidenceRefs` is an array of evidence references that may be empty. It returns `status: no-change` and explains why in `rationale`.

### Step 1: Write the plugin

In a TypeScript ESM project with `ember-rsi` installed, place the three files in `src/proposer-keep-parent/` and compile them to `dist/proposer-keep-parent/`.

#### 1. Define configuration

Define the configuration type and validation rules in `schema.ts`. This example requires a nonempty `reason`:

```ts
import type { JsonSchema } from 'ember-rsi/contracts';

// Plugin configuration and its validation rules.
export type KeepParentConfig = { reason: string };

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    reason: { type: 'string', minLength: 1 },
  },
  required: ['reason'],
  additionalProperties: false,
};
```

#### 2. Implement business logic

Return a plugin instance from `service.ts`. `execute` receives the current call's input and RuntimeContext; `dispose` handles instance cleanup:

```ts
import type {
  Operation,
  ProposerInput,
  ProposerOutput,
  RuntimeContext,
} from 'ember-rsi/contracts';
import type { KeepParentConfig } from './schema.js';

export async function createKeepParent(
  config: KeepParentConfig,
  _context: RuntimeContext,
): Promise<Operation<ProposerInput, ProposerOutput>> {
  return {
    // Check cancellation and the parent candidate, then return it unchanged.
    async execute(input, context): Promise<ProposerOutput> {
      context.signal.throwIfAborted();
      await context.readCandidate(input.parent);
      return {
        status: 'no-change',
        candidateRef: input.parent,
        diffRef: null,
        rationale: config.reason,
      };
    },
    // This example owns no long-lived resources.
    async dispose(): Promise<void> {},
  };
}
```

#### 3. Assemble the plugin definition

In `index.ts`, specify the implementation ID and combine the contract, configuration Schema, and `create` function into a definition:

```ts
import {
  proposerContract,
  type OperationDefinition,
  type ProposerInput,
  type ProposerOutput,
} from 'ember-rsi/contracts';
import { configSchema, type KeepParentConfig } from './schema.js';
import { createKeepParent } from './service.js';

export const keepParentDefinition: OperationDefinition<
  ProposerInput,
  ProposerOutput,
  KeepParentConfig
> = {
  id: 'proposer.keep-parent',
  description: 'Keep the parent candidate without edits.',
  contract: proposerContract,
  configSchema,
  create: createKeepParent,
};
```

### Step 2: Register the plugin

Runtime finds plugins by registered ID. Creating a file or adding an ID to a Recipe does not load code automatically. Choose one of these registration methods:

| Method               | When to use it                                                           |
| -------------------- | ------------------------------------------------------------------------ |
| Modify the source    | Modify RSI source to build and provide the plugin with the framework.    |
| Load through the CLI | Develop in your own extension project and load it with an installed CLI. |

#### Method 1: Modify the source

1. Place the three example files in `src/plugins/proposer-keep-parent/` and replace their `ember-rsi/contracts` imports with `../../contracts/index.js`.
2. Import `keepParentDefinition` in the [built-in registration file](../../../src/runtime/builtins.ts) and add it to the `definitions` array in `registerBuiltins`.
3. Run `pnpm build` from the repository root. Then validate and run through the repository's `pnpm ember-rsi` command, as shown in the shared steps below.

#### Method 2: Register an external extension for the CLI

1. Use `my-extension/` as the project containing the three example files. Run the project's build command to generate `dist/proposer-keep-parent/` and ensure runtime dependencies are installed.
2. Create `index.mjs` in the `my-extension/` root, exporting `register(registry)`. The CLI calls it when loading the extension:

   ```js
   import { keepParentDefinition } from './dist/proposer-keep-parent/index.js';

   export function register(registry) {
     registry.registerOperation(keepParentDefinition);
   }
   ```

3. Pass `--plugin-dir ./my-extension` when validating, running, or resuming to load the extension. One entrypoint can register multiple plugins; if one already exists, add the code to its existing `register` function.
   - Alternatively, place the extension in `~/.ember-rsi/plugins/<name>/` so the CLI loads its `index.mjs` automatically. User-level extensions load in directory-name order, followed by directories passed through `--plugin-dir`; the option can be repeated.

#### When you need a new contract

If no existing contract fits, use `defineContract({ id, input_schema, output_schema })` to define one, set the plugin's `contract` to that object, and use the new contract ID in your custom Policy's `require`.

`registerOperation(definition)` registers both the plugin and its contract. You can also register a contract separately with `registerContract(contract)`.

- Complete registration before loading the Policy. Schemas sharing a contract ID must agree. For Policy registration, see [Write a Policy](writing-policies.md#register-a-policy).

### Step 3: Use it in a Policy and Recipe

#### 1. Declare the binding and call in the Policy

The Policy declares binding names, and steps select a binding through `use`. Here, `proposer` is the binding name and `propose` is the step ID; read the result through `steps.propose.output`.

This is a Policy excerpt. Add it to a [complete Policy](writing-policies.md) and register it. If an existing Policy already declares a binding with the corresponding contract, select the plugin directly in the Recipe:

```yaml
# Declare the public contract required by the proposer binding.
require:
  proposer:
    contract: contract.proposer

# Supply a default plugin and configuration that the Recipe can override.
defaults:
  bindings:
    proposer:
      plugin: proposer.keep-parent
      config:
        reason: Keep the baseline for this demonstration.

# Call the plugin with the parent candidate, goal, and evidence references.
steps:
  - id: propose
    type: invoke
    use: proposer
    with:
      parent: ${{ application.initialCandidate }}
      goal: Check the plugin integration.
      evidenceRefs: []
```

#### 2. Select the plugin and configuration in the Recipe

Recipe `bindings` use the names declared by the Policy. Select the implementation and supply configuration for `proposer`:

```yaml
bindings:
  proposer:
    plugin: proposer.keep-parent
    config:
      reason: Keep the parent in this experiment.
```

Omit `plugin` to keep the Policy's default implementation. A replacement must satisfy the binding's contract. Supply `config` according to the selected plugin's Schema; missing required fields fail validation. See [Configuration](configuration.md#recipe-fields-and-binding-overrides) for merge and override rules.

#### 3. Validate and run

Once the complete Recipe is ready, run commands for your registration method.

**After modifying the source**, use the newly built CLI from the repository root:

```sh
pnpm ember-rsi validate my-experiment/recipe.yaml
pnpm ember-rsi run my-experiment/recipe.yaml --id custom-run
```

**When loading through the CLI**, run from the working directory containing `my-extension/` and `my-experiment/`, loading the same extension in both commands:

```sh
ember-rsi validate my-experiment/recipe.yaml --plugin-dir ./my-extension
ember-rsi run my-experiment/recipe.yaml --id custom-run --plugin-dir ./my-extension
```

`validate` checks contracts, bindings, and configuration without executing plugin business logic. After running, check that `propose` returns `status: no-change` and the expected `rationale`; see [Run and inspect experiments](running-experiments.md) for viewing step results.

## Use RuntimeContext

Runtime passes `context` to `create` and every `execute` call. Plugins use it to read candidates, save results, call other plugins, and respond to cancellation. See [execution context fields](../../../src/contracts/runtime/execution.ts) and [service interfaces](../../../src/contracts/runtime/services.ts) for the complete interfaces.

| Task                                 | Field or method                                          | Purpose                                                                                                                                  |
| ------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Identify the current call            | `experimentId`, `callId`, `bindingId`, `idempotencyKey`  | Read experiment, call, binding, and idempotency identifiers; pass the idempotency key to external services supporting idempotent writes. |
| Respond to cancellation              | `signal`, `cleanup`                                      | Use `signal` for business operations and the separate `cleanup` signal for resource release after cancellation.                          |
| Read a candidate                     | `readCandidate(ref)`                                     | Return the candidate record, including the `artifactRef` that holds its content.                                                         |
| Record a candidate                   | `recordCandidate(artifactRef, parentRef)`                | Return a candidate reference, typically called by the Application after checking the modification scope.                                 |
| Read or save a measurement           | `readMeasurement(ref)`, `recordMeasurement(measurement)` | Read a measurement record, or validate it against the public protocol and save it to obtain a reference.                                 |
| Save or read content                 | `artifacts.putJson/readJson`, `capture/materialize`      | Save and read JSON, or save directory contents and restore them to a local directory.                                                    |
| Edit in a temporary directory        | `workspaces.create/read/release`                         | Create or read a workspace, edit files in its `directory`, and release it when finished.                                                 |
| Call the Application                 | `application(input)`, `applicationMetadata()`            | Execute lifecycle actions or read metadata such as the target, capabilities, and initial candidate.                                      |
| Use a candidate's execution instance | `withInstance(candidateRef, capability, use)`            | Acquire an instance, execute `use(execution)`, and coordinate its release.                                                               |
| Call another binding                 | `invoke(bindingName, input)`                             | Apply Runtime contract validation, budget checks, call recording, and revision selection.                                                |
| Call an Agent                        | `invokeAgent(input)`                                     | Select the Agent binding through `input.agentRef`, defaulting to `agent.default` when omitted.                                           |
| Read evidence                        | `readEvidence(refs, options?)`                           | Select `view`, file or JSON format, and `maxBytes` to read the evidence available to this call.                                          |
| Record usage                         | `charge(metric, amount)`                                 | Record usage and check budgets; call with `await`.                                                                                       |
| Subscribe to events                  | `event`                                                  | Listen for runtime events and unsubscribe when finished; see [Runtime events](runtime-events.md).                                        |

### Calls and resource cleanup

- Loading a Recipe only assembles definitions. Execution calls `create` to create instances and `execute` to perform business work. Runtime validates input/output and records calls.
- One instance can serve multiple calls, including concurrent ones. Keep each call's data and temporary resources local to that call, using the context received by the current `execute`; the `create` context is for instance resources.
- Pass cancellation signals to external requests and long-running operations. Release call-owned workspaces, files, and temporary processes in `finally`, and long-lived resources in `dispose`. If `create` fails before returning, clean up any resources it has already created.

## Use in a host application

Besides the CLI, your own program can create a Runtime and register plugins. This example assumes a complete `policy.my-search` file and a Recipe referencing it:

```ts
import { resolve } from 'node:path';
import { createRuntime, validateRecipe } from 'ember-rsi';
import { keepParentDefinition } from './my-extension/dist/proposer-keep-parent/index.js';

// Create Runtime, disable user-level extension loading, and register definitions directly.
const runtime = await createRuntime({
  rootDirectory: process.cwd(),
  homeDirectory: false,
});
try {
  runtime.registry.registerOperation(keepParentDefinition);
  runtime.registry.registerPolicy(
    'policy.my-search',
    resolve('./my-extension/policy.yaml'),
  );

  // Validate and run the complete Recipe with the same Runtime.
  const recipePath = resolve('./my-experiment/recipe.yaml');
  const check = await validateRecipe(runtime, recipePath);
  console.log(check);
  const result = await runtime.manager.run(recipePath, { id: 'custom-run' });
  console.log(result.status, result.output);
} finally {
  await runtime.dispose();
}
```

Common `createRuntime` options are listed below; see the [Runtime entrypoint](../../../src/runtime/context.ts) for all options. These are host API parameters.

| Option              | Meaning                                                                      | When omitted                     |
| ------------------- | ---------------------------------------------------------------------------- | -------------------------------- |
| `rootDirectory`     | Host working root directory.                                                 | Current process directory.       |
| `directory`         | Directory for Runtime data.                                                  | `.rsi/` under the working root.  |
| `homeDirectory`     | User-level extension home; set `false` to disable automatic loading.         | `~/.ember-rsi`.                  |
| `pluginDirectories` | Additional extension directories, relative to the current process directory. | No extra directories are loaded. |

Registrations in a host only apply to that Runtime. A separately started CLI still needs source registration or `--plugin-dir` to load the plugin.
