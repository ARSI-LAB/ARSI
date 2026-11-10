# Implement a compatible plugin

Use the complete [external implementations](../assets/minimal/extension/operations.mjs) and [registration entry](../assets/minimal/extension/index.mjs). They import only the two public package entrypoints and run through real Manager calls.

An OperationDefinition has `id`, a **contract object** such as imported `proposerContract` (not the string `contract.proposer`), `configSchema`, async `create(config, services)` returning `{ execute(input, context), dispose() }`, and optional `doctor`, `description` and `implementationDigest`. Contract owns input/output schemas; implementation owns config. Historical `display`/`presentation` metadata is unsupported. Keep configuration validation at the public boundary and treat model results as untrusted until validated.

A Policy's `require` instead uses the **contract ID string**, e.g. `proposer: { contract: contract.proposer }`. A Recipe binding chooses your implementation ID. Register in the executing host before validation; see [external extensions](external-plugins.md).

For larger TypeScript plugins organize schema.ts (configuration), service.ts (behavior), index.ts (assembly). Compile to modules Node can load. Expose one contract per operation; lifecycle actions use its discriminated union. Shared internal tools are not separate public plugins.

Read [service signatures](runtime-services.md) before storing candidates/measurements or acquiring instances. The starter covers Application commits, no-change outputs, measurement/evidence construction, budget charge, instance release and disposal. Implementing an evaluator under `contract.agentbench` does not imply it uses the Evaluator SDK; accurately label its actual measurement method.

The SDK adapter's runner-injection helpers are internal, not exported package APIs. They may be used in repository development tests, but cannot be an installed consumer's integration prerequisite. Use the stock evaluator with its configured backend or implement the public evaluator contract. Never import `src/plugins/...` from a consumer.

Verify invalid inputs/config, actual outputs, relevant side effects, no-change behavior, cancellation, repeat/unknown-effect handling and owned-resource cleanup. Do not count a registration-only or schema-only test as successful plugin execution.

Attach a repeatable preflight function as `doctor: checkCustom` on the component definition and keep `registry.registerOperation(definition)` unchanged. TypeScript authors can use public `OperationDoctor<C>` and `DoctorContext<C>` from `ember-rsi/contracts`; the callback receives effective configuration through `context.binding.config`. Record bounded operations through `context.check`, unsupported/dependent work through `context.unchecked`, and missing inputs through `context.missing`. Export and package the callback with the component; no global mapping, extra registration call, Recipe field or required check filename is needed. The CLI invokes it only during `doctor`, not registration, `Recipe.load` or normal execution. Without the optional callback, generic registration/contract/configuration/path checks still run and plugin-specific coverage is `unchecked`.

Reuse preparation or bounded local lifecycle operations without running Agents, model inference or benchmarks. SDK-backed Evaluators adapt normal configuration and delegate to SDK doctor rather than duplicating its probes. Use `context.directory` or the isolated Runtime for temporary writes, propagate each check's signal, and release owned resources on success, failure and interruption. Verify a working input, a concrete broken prerequisite and relevant cancellation/cleanup boundaries.

For example, an editor configured with `config: { prompt: ./prompt.md, agentRef: agent }` can check that `agent` implements the Agent contract and load the resolved `prompt` with the existing prompt loader. In separate temporary fixtures, use a readable prompt for the working case and a missing prompt for the fault case. Assert that the fault identifies `config.prompt`, leaves project preparation unchecked, and preserves an independent check. Exercise the callback during development, then run `ember-rsi doctor recipe.yaml --plugin-dir ./extension` with the packaged component to verify discovery and JSON/exit status. Do not report missing doctor coverage as a successful component check.

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
