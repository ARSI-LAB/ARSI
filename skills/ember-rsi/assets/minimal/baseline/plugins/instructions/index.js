import { readFileSync } from 'node:fs';
export const name = 'instructions';
export const inject = ['systemPrompt'];
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'skill:instructions',
    order: 3300,
    interpolate: false,
    text: readFileSync(new URL('../../prompt.md', import.meta.url), 'utf8'),
  });
}
