import { fileURLToPath } from 'node:url';
export function register(registry) {
  registry.registerPolicy(
    'policy.skill-terminalbench',
    fileURLToPath(new URL('../terminalbench-policy.yaml', import.meta.url)),
  );
}
