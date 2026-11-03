import { fileURLToPath } from 'node:url';
export function register(registry) {
  registry.registerPolicy(
    'policy.skill-model',
    fileURLToPath(new URL('../model-policy.yaml', import.meta.url)),
  );
  registry.registerPolicy(
    'policy.skill-memory',
    fileURLToPath(new URL('../memory-policy.yaml', import.meta.url)),
  );
  registry.registerPolicy(
    'policy.skill-reflection',
    fileURLToPath(new URL('../reflection-policy.yaml', import.meta.url)),
  );
  registry.registerPolicy(
    'policy.skill-learning',
    fileURLToPath(new URL('../learning.yaml', import.meta.url)),
  );
}
