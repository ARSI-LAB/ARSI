import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'terminal-base';
export const inject = ['systemPrompt'];

export function apply(ctx) {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const instruction = readFileSync(join(root, 'prompts/baseline.md'), 'utf8');
  const skillsRoot = join(root, 'skills');
  const entries = existsSync(skillsRoot)
    ? readdirSync(skillsRoot, { withFileTypes: true })
    : [];
  const skills = entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) =>
      readFileSync(join(skillsRoot, entry.name, 'SKILL.md'), 'utf8'),
    );
  const text = [instruction, ...skills].filter(Boolean).join('\n\n');
  if (!text) return;
  ctx.systemPrompt.section({
    name: 'terminal:instructions',
    order: 3300,
    interpolate: false,
    text,
  });
}
