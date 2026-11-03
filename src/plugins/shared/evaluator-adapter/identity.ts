import { readFile } from 'node:fs/promises';
import { digest } from '../../../shared/json.js';
export async function sourceIdentity(
  base: string,
  files: readonly string[],
): Promise<string> {
  const extension = base.endsWith('.ts') ? '.ts' : '.js';
  return digest(
    await Promise.all(
      files.map(async (name) => ({
        name,
        source: await readFile(new URL(name + extension, base), 'utf8'),
      })),
    ),
  );
}
