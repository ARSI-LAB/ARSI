import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonObject } from '../../../contracts/index.js';
import { recordSchema } from '../../../contracts/models/measurement.js';
import { digest, object, string } from '../../../shared/json.js';
import { validate } from '../../../shared/schema.js';

const text: JsonObject = { type: 'string', minLength: 1 };
const shape = {
  type: 'array',
  minItems: 1,
  items: { type: 'integer', minimum: 1 },
};
const tensorSchema = recordSchema({ shape, dtype: { const: 'float16' } });
const taskSchema = recordSchema({
  schemaVersion: { const: 'rsi.kernel-task/v1' },
  id: text,
  cases: {
    type: 'array',
    minItems: 1,
    maxItems: 100,
    items: recordSchema({ id: text, seed: { type: 'integer', minimum: 0 } }),
  },
  contract: recordSchema({
    inputs: { type: 'array', minItems: 1, items: tensorSchema },
    output: recordSchema({
      shape,
      dtype: { const: 'float16' },
      contiguous: { type: 'boolean' },
      independent: { type: 'boolean' },
    }),
    inputUnmodified: { type: 'boolean' },
  }),
});

const sha = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
export async function loadOperatorTask(directory: string): Promise<{
  definition: JsonObject;
  taskDigest: string;
  cases: { id: string; seed: number }[];
}> {
  const files: JsonObject = {};
  for (const name of ['task.json', 'problem.py', 'test.py']) {
    const path = join(directory, name);
    if (!(await lstat(path)).isFile())
      throw new Error(`Operator task ${name} must be an ordinary file`);
    files[name] = sha(await readFile(path));
  }
  const definition = object(
    JSON.parse(await readFile(join(directory, 'task.json'), 'utf8')),
  );
  validate(taskSchema, definition, 'operator task');
  const cases = (definition.cases as JsonObject[]).map((c) => ({
    id: string(c.id),
    seed: Number(c.seed),
  }));
  if (new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error('Operator task case IDs must be unique');
  delete files['task.json'];
  return { definition, cases, taskDigest: digest({ definition, files }) };
}
