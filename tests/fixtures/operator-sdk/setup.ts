import { cp, mkdtemp, chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'yaml';
import { object } from '../../../src/shared/json.js';

export async function prepareOperatorFixture(): Promise<{
  root: string;
  recipePath: string;
  worker: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'rsi-calibration-'));
  const example = join(root, 'example');
  await cp(
    new URL(
      '../../../examples/artifacts/kernel/qianchuan-top3/',
      import.meta.url,
    ),
    example,
    { recursive: true },
  );
  const worker = join(root, 'worker.mjs');
  await cp(new URL('./worker.mjs', import.meta.url), worker);
  await chmod(worker, 0o755);
  const recipePath = join(example, 'recipe.sdk.yaml');
  const recipe = object(parse(await readFile(recipePath, 'utf8')));
  const sdk = object(
    object(object(object(recipe.bindings).evaluator).config).sdk,
  );
  sdk.python = worker;
  sdk.timeoutSeconds = 15;
  await writeFile(recipePath, stringify(recipe));
  return { root, recipePath, worker };
}
