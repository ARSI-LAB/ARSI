import { fileURLToPath } from 'node:url';
import { proposer, evaluator } from './operations.mjs';
export function register(registry) {
  registry.registerOperation(proposer);
  registry.registerOperation(evaluator);
  registry.registerPolicy(
    'policy.skill-search',
    fileURLToPath(new URL('../policy.yaml', import.meta.url)),
  );
}
