import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'gaia-base';
export const inject = ['systemPrompt'];

export function apply(ctx) {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const text = readFileSync(join(root, 'prompts/gaia.md'), 'utf8').trim();
  if (!text) return;
  ctx.systemPrompt.section({
    name: 'gaia:instructions',
    order: 3300,
    interpolate: false,
    text,
  });
}
