# Embed the Runtime

The fully runnable [run.mjs](../assets/minimal/run.mjs) creates a host, loads extensions, assembles a Recipe, awaits execution, checks facts and disposes in finally. Copy its entire directory as described in [quickstart](quickstart.md). For experiment preflight, run `ember-rsi doctor <recipe.yaml>` in the intended environment with the same extension directories.

```js
import { resolve } from 'node:path';
import { createRuntime, Recipe } from 'ember-rsi';
const runtime = await createRuntime({
  rootDirectory: process.cwd(),
  directory: resolve('.rsi'),
  pluginDirectories: [resolve('.rsi/skill-demo/extension')],
});
try {
  const path = resolve('.rsi/skill-demo/recipe.yaml');
  const recipe = await Recipe.load(path, runtime.registry);
  console.log({ recipeId: recipe.id, policyId: recipe.policy.id });
  const result = await runtime.manager.run(path, { id: 'embedded-01' });
  console.log(result);
  console.log(await runtime.manager.get('embedded-01'));
} finally {
  await runtime.dispose();
}
```

Register in this same host, either through pluginDirectories or `runtime.registry.registerOperation(definition)` / `registerPolicy(id, absolutePath)`. `runtime` exposes context, registry, manager and dispose; there are no recipes/definitions/runs/queries service facades. A separate CLI process does not inherit registrations.

`manager.run(path, { id?, resume?, signal? })` is awaited by its owner. For cancellation pass an AbortController signal or await `manager.cancel(id)`, then observe completion/cleanup. `manager.get(id)` returns the record; `manager.list()` returns records. Read [recovery](cli.md#resume-without-corrupting-history) before resuming uncertain effects.

Use execution-scoped [services](runtime-services.md) inside plugins. Host context does not grant permission to create arbitrary experiment facts. Public `manager.facts` and `manager.artifacts` support inspection; do not mutate stored facts directly.

## Stage handoff

Read the selected candidate fact by its returned candidateRef, retain its paired measurementRef, and use `runtime.manager.artifacts.materialize(candidate.artifactRef, destination)` to produce the next baseline. The destination must be a new or empty real directory (not a symlink). Materialization does not merge into or overwrite a previous output; use a fresh directory for repeated inspection. Or use `baseline: { artifactRef }` within the same artifact store. Start a new ID for a changed goal/Recipe and record the prior selection as provenance. The new Application creates a fresh baseline candidate; it does not automatically inherit cross-experiment parentRef.

## Validation and error boundaries

`Recipe.load(path, runtime.registry)` checks Recipe/Policy configuration, registrations, contracts and declared Reflection resources, returning the assembled definition without creating plugin instances. Doctor uses this same loading path and adds bundled prerequisite checks; use its CLI report for preflight findings.

Neither Recipe loading nor doctor evaluates the final Policy input against `input_schema`; defaults may depend on the initialized Application. A Recipe with an invalid explicit `policy.input` can therefore load successfully and fail during `manager.run`. Doctor may also leave prerequisite checks `unchecked`, so zero failed checks does not guarantee execution success.

`manager.run` rejects on execution failure or cancellation rather than returning a failed record normally. When the experiment record has been persisted, `manager.get(id)` exposes its failed/cancelled status afterward. Earlier setup errors may leave no record. Catch the run rejection, inspect a known record if available, and always await disposal. For a deliberate bad-input test:

```js
await assert.rejects(
  runtime.manager.run(badRecipePath, { id: 'invalid-input-01' }),
  /policy\.input/,
);
```

Import `assert` from `node:assert/strict`; prepare the bad-input fixture before executing the test. Match the expected failure boundary, not an assumption that every invalid input is rejected by `Recipe.load` or doctor.
