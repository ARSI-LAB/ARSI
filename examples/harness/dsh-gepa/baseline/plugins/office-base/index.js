import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'office-base';
export const inject = ['systemPrompt'];

export function apply(ctx) {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const instruction = readFileSync(
    join(root, 'prompts/office-discipline.md'),
    'utf8',
  );
  const skillsRoot = join(root, 'skills');
  const skills = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) =>
      readFileSync(join(skillsRoot, entry.name, 'SKILL.md'), 'utf8'),
    );
  ctx.systemPrompt.section({
    name: 'office:instructions',
    order: 3300,
    interpolate: false,
    text: [instruction, ...skills].join('\n\n'),
  });
}
