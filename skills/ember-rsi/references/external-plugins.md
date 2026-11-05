# Load external extensions at startup

The default extension home is `~/.ember-rsi/`. Immediate directories `plugins/<name>/index.mjs` load automatically in name order. A missing home/plugins directory is allowed; invalid discovered extensions fail startup. Other files are ignored. Experiment facts remain in the working directory's `.rsi/`.

Use repeatable `--plugin-dir` options after the command:

```sh
ember-rsi catalog --plugin-dir ./my-extension
ember-rsi validate ./recipe.yaml --plugin-dir ./my-extension
ember-rsi run ./recipe.yaml --plugin-dir ./my-extension --id experiment-01
ember-rsi dashboard --plugin-dir ./my-extension --port 4317
```

Each explicitly selected directory contains `index.mjs` exporting `register(registry)`. Synchronous and asynchronous registration are supported. A directory can register several implementations and Policies. RSI does not recursively scan subdirectories or auto-import arbitrary files. Compiled plugin modules and their dependencies must be available to Node.

```text
my-extension/
  index.mjs
  implementation.mjs
  policies/
    search.yaml
```

Example `index.mjs`, with an implementation exporting its existing OperationDefinition:

```js
import { fileURLToPath } from 'node:url';
import { myDefinition } from './implementation.mjs';

export function register(registry) {
  registry.registerOperation(myDefinition);
  registry.registerPolicy(
    'policy.my-search',
    fileURLToPath(new URL('./policies/search.yaml', import.meta.url)),
  );
}
```

Recipe refs use registered IDs. Policies use `rsi.policy/v1` and registered contract IDs. Registration defines capabilities; operation create/execute/dispose own runtime work. Defining a file alone does not enable it.

Directory arguments resolve against the process working directory. Use `import.meta.url` for extension-local resources. Policy-local resource origins retain existing loader semantics. Programmatic hosts may set `homeDirectory` to another home or `false` for isolation, and use `createRuntime({ pluginDirectories: ['./my-extension'] })`.

Builtins register first, then home extensions, then explicit directories in argument order. Repeated directories resolving to the same real path register once per Runtime. Missing/invalid entrypoints, registration failures and duplicate IDs stop startup with directory context. Builtin IDs cannot be silently overridden. Registration runs again for each new Runtime even when Node caches the imported module.

All commands share loading, including Web startup. Use the same directories when validating, running or resuming and preserve extension versions/resources. This is startup loading; changing files does not reload a running experiment.

A complete working extension is included at [extension/index.mjs](../assets/minimal/extension/index.mjs).
