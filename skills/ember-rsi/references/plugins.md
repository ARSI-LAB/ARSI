# Implement a compatible plugin

Use the complete [external implementations](../assets/minimal/extension/operations.mjs) and [registration entry](../assets/minimal/extension/index.mjs). They import only the two public package entrypoints and run through real Manager calls.

An OperationDefinition has `id`, a **contract object** such as imported `proposerContract` (not the string `contract.proposer`), `configSchema`, async `create(config, services)` returning `{ execute(input, context), dispose() }`, and optional `description` and `implementationDigest`. Contract owns input/output schemas; implementation owns config. Historical `display`/`presentation` metadata is unsupported. Keep configuration validation at the public boundary and treat model results as untrusted until validated.

A Policy's `require` instead uses the **contract ID string**, e.g. `proposer: { contract: contract.proposer }`. A Recipe binding chooses your implementation ID. Register in the executing host before validation; see [external extensions](external-plugins.md).

For larger TypeScript plugins organize schema.ts (configuration), service.ts (behavior), index.ts (assembly). Compile to modules Node can load. Expose one contract per operation; lifecycle actions use its discriminated union. Shared internal tools are not separate public plugins.

## Keep implementation changes inside the authorized scope

A plugin task authorizes particular paths — typically the plugin modules plus its Policy, Recipe and tests. Contract objects and their types come from the installed package: import them, do not extend them. Declare helper types, configuration fields, result shapes and internal enums in the plugin's own files even when a shared `src/contracts/...` module looks like their natural home. Editing a shared contract, type barrel or baseline consumer so that new code compiles changes semantics for every other plugin, and it is reported as an unauthorized delivery change even when the local tests pass.

When the public contract genuinely lacks something the algorithm needs, report that as the smallest out-of-scope requirement and keep the deliverable within its authorized paths instead of absorbing the gap in shared modules. Before reporting completion, list the delivered paths, compare them with the authorized entries, and explain or remove every path that is not listed.

Read [service signatures](runtime-services.md) before storing candidates/measurements or acquiring instances. The starter covers Application commits, no-change outputs, measurement/evidence construction, budget charge, instance release and disposal. Implementing an evaluator under `contract.agentbench` does not imply it uses the Evaluator SDK; accurately label its actual measurement method.

The SDK adapter's runner-injection helpers are internal, not exported package APIs. They may be used in repository development tests, but cannot be an installed consumer's integration prerequisite. Use the stock evaluator with its configured backend or implement the public evaluator contract. Never import `src/plugins/...` from a consumer.

Verify invalid inputs/config, actual outputs, relevant side effects, no-change behavior, cancellation, repeat/unknown-effect handling, owned-resource cleanup and any declared termination or eligibility invariant. Do not count a registration-only or schema-only test as successful plugin execution; exercise the composed path with the limits the Recipe declares.

## Discover schemas through public APIs

`ember-rsi list plugins` and `ember-rsi list policies` expose descriptions, Schemas and contract-compatible bindings. Add a concise `description` to your OperationDefinition so installed users can discover its purpose. An omitted description is reported as null. Compatibility describes declared Policy requirements, not measured suitability.

`ember-rsi catalog` and GET `/api/catalog` return only `{ plugins: string[], policies: string[] }`. They confirm registered IDs, not configuration validity or full schemas. In an embedded host, query public definitions without inspecting implementation functions:

```js
const definition = runtime.registry.get('proposer.agent');
console.log(
  JSON.stringify(
    {
      id: definition.id,
      contract: definition.contract,
      configSchema: definition.configSchema,
    },
    null,
    2,
  ),
);
```

For a registered Policy, import `Policy` from `ember-rsi`, then call `const policy = await Policy.load(runtime.registry.policy('policy.wikiskill'), runtime.registry)`. Its public compiled data includes `policy.inputSchema`, `outputSchema`, `configSchema`, `stateSchema`, `policy.requirements`, and `policy.defaults`. Read only the data needed for configuration; no source checkout or private module import is necessary. Register extensions in that host first, and dispose it afterward. Schema lookup is read-only and does not run a model or benchmark.
