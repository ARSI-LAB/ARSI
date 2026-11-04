# Write a plugin

English | [简体中文](writing-plugins_zh.md) · [Getting started](../getting-started.md)

## Choose the extension boundary

| Need                                                                               | Extension                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Change tasks, limits, model, or existing prompt paths                              | Override the corresponding Recipe configuration or binding.   |
| Replace inference/tool execution while reusing Proposer evidence and edit handling | Implement `contract.agent` and replace the `agent` binding.   |
| Replace the complete proposal workflow                                             | Implement `contract.proposer` and replace a Proposer binding. |
| Change orchestration, state, or stopping rules                                     | Register a custom Policy.                                     |

Bindings merge at the binding/configuration level; they are not an arbitrary recursive merge. Inspect the [loader](../../../src/runtime/loaders/index.ts) when replacing nested configuration. A `ref` selects a registered implementation; it does not import a file or register code.

Organize a plugin around `schema.ts` (configuration), `service.ts` (business behavior and cleanup), and `index.ts` (definition assembly). Reuse the public contract's input/output schemas. Repository plugins import local contracts; external packages use `ember-rsi` or `ember-rsi/contracts`, not private `src/*` imports.

A custom Agent must return an object matching the requested `input.outputSchema`, enforce its authorized tools/files, propagate cancellation, charge actual model attempts with `context.charge('modelCalls', 1)`, and release resources. Implementing the Agent contract does not automatically enforce the requested output schema inside an arbitrary backend; the backend must validate it. For the built-in Proposer, the edit protocol is defined in [shared editing code](../../../src/plugins/shared/agent-editing/index.ts).

## Implement the plugin lifecycle

1. Find the [public contract](../../../src/contracts/plugin-types/index.ts) required by the Policy slot and reuse its input and output types. Define the plugin configuration, defaults, and constraints in `schema.ts`.
2. Implement `create(config, context)` in `service.ts`. Return `execute(input, context)` and `dispose()`. Use the call's `RuntimeContext` to read candidates and evidence, commit edits, or record measurements. Propagate cancellation to external calls and release resources owned by the call.
3. Assemble the `OperationDefinition` in `index.ts` with a unique implementation ID, the public contract, the configuration Schema, and the factory. Use the contract ID in the Policy's `require` and the implementation ID in the Recipe binding's `ref`.

For example, `selector.metric` implements `contract.selector-metrics`. Its execution reads two measurement references, checks comparability, and saves a selection record. See its [definition](../../../src/plugins/selector-metrics/index.ts), [configuration Schema](../../../src/plugins/selector-metrics/schema.ts), and [service](../../../src/plugins/selector-metrics/service.ts). For an editing plugin, the [skill's deterministic Proposer](../../../skills/ember-rsi/assets/minimal/extension/operations.mjs) shows how to commit through the Application and release a workspace in `finally`.

## Register an external extension for the CLI

Default extensions load from `~/.ember-rsi/plugins/<name>/index.mjs` in name order, before extra `--plugin-dir` directories. A missing home is allowed; invalid discovered extensions fail startup. Experiment data remains in the working directory's `.rsi/`. Embedded hosts can set `homeDirectory: false` for isolation.

Every CLI command accepts repeatable `--plugin-dir <directory>` options. Each directory contains an ESM `index.mjs` exporting `register(registry)`. The extension and its dependencies must be built/resolvable before loading:

```js
// my-extension/index.mjs
import { myAgentDefinition } from './agent.js';

export function register(registry) {
  registry.registerOperation(myAgentDefinition);
}
```

Set `bindings.agent.ref: agent.my-custom` in your Recipe, matching the definition's ID, then pass the extension on each command that needs it:

```sh
ember-rsi validate ./my-recipe/recipe.yaml --plugin-dir ./my-extension
ember-rsi run ./my-recipe/recipe.yaml --id custom-run --plugin-dir ./my-extension
```

For a built-in repository extension, add its definition to [registerBuiltins](../../../src/runtime/builtins.ts) and rebuild. Creating a source file alone does not register it.

## Embed the Runtime

An external host can register definitions directly. Validation and execution must use a Runtime with the same registrations:

```ts
import { resolve } from 'node:path';
import { createRuntime, validateRecipe } from 'ember-rsi';
import { myAgentDefinition } from './plugins/agent-custom/index.js';

const runtime = await createRuntime({ rootDirectory: process.cwd() });
try {
  runtime.registry.registerOperation(myAgentDefinition);
  const recipePath = resolve('./my-recipe/recipe.yaml');
  const check = await validateRecipe(runtime, recipePath);
  console.log(check);
  const result = await runtime.manager.run(recipePath, { id: 'custom-run' });
  console.log(result.status, result.output);
} finally {
  await runtime.dispose();
}
```

Direct registration in a host process does not modify a separately started CLI process. Use that host for management calls, or load the same extension through `--plugin-dir`. Never persist live `RuntimeContext` objects as JSON.
