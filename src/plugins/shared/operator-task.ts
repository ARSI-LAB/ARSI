import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonObject } from '../../contracts/index.js';
import { recordSchema } from '../../contracts/models/measurement.js';
import { digest, object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';

const text: JsonObject = { type: 'string', minLength: 1 };
const shape = {
  type: 'array',
  items: { type: 'integer', minimum: 1 },
};
const dtype = { enum: ['float16', 'bfloat16', 'float32'] };
const tensorSchema = recordSchema(
  { shape, dtype, contiguous: { type: 'boolean' } },
  ['shape', 'dtype'],
);
const taskSchema = recordSchema({
  schemaVersion: { const: 'rsi.kernel-task/v1' },
  id: text,
  cases: {
    type: 'array',
    minItems: 1,
    items: recordSchema({ id: text, seed: { type: 'integer', minimum: 0 } }),
  },
  contract: recordSchema({
    inputs: { type: 'array', minItems: 1, items: tensorSchema },
    output: recordSchema({
      shape,
      dtype,
      contiguous: { type: 'boolean' },
      independent: { type: 'boolean' },
    }),
    inputUnmodified: { type: 'boolean' },
  }),
});

const sha = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
async function readTaskFile(directory: string, name: string): Promise<Buffer> {
  const path = join(directory, name);
  if (!(await lstat(path)).isFile())
    throw new Error(`Operator task ${name} must be an ordinary file`);
  return readFile(path);
}

export async function loadOperatorTask(directory: string): Promise<{
  definition: JsonObject;
  reference: Buffer;
  taskDigest: string;
  cases: { id: string; seed: number }[];
}> {
  const definition = object(
    JSON.parse((await readTaskFile(directory, 'task.json')).toString('utf8')),
  );
  validate(taskSchema, definition, 'operator task');
  const cases = (definition.cases as JsonObject[]).map((c) => ({
    id: string(c.id),
    seed: Number(c.seed),
  }));
  if (new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error('Operator task case IDs must be unique');
  const reference = await readTaskFile(directory, 'problem.py');
  const files = {
    'problem.py': sha(reference),
    'test.py': sha(await readTaskFile(directory, 'test.py')),
  };
  return {
    definition,
    cases,
    reference,
    taskDigest: digest({ definition, files }),
  };
}
