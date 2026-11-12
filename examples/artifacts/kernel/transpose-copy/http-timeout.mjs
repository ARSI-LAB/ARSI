import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const recipe = parse(
  readFileSync(new URL('./recipe.search.yaml', import.meta.url), 'utf8'),
);
// Use the HTTP dispatcher from the same pinned SDK that sends the model requests.
const { configureHttpDispatcher } = await import(
  new URL(
    './core/http-dispatcher.js',
    import.meta.resolve('@earendil-works/pi-coding-agent'),
  )
);
configureHttpDispatcher(recipe.bindings.agent.config.timeoutMs);
