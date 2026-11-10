import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RuntimeContext,
  type JsonObject,
  type Operation,
} from '../../src/contracts/index.js';
import { object } from '../../src/shared/json.js';

/** Read the real plugin's SDK input, stopping at the evaluation budget boundary. */
export async function captureEvaluatorConfiguration<
  I extends JsonObject,
  O extends JsonObject,
>(
  operation: Operation<I, O>,
  input: I,
  execution: JsonObject,
  directory: string,
): Promise<JsonObject> {
  const stopped = new Error('Stop before evaluation');
  let released = false;
  const context = new RuntimeContext().extend({
    directory,
    signal: new AbortController().signal,
    charge: async () => {
      throw stopped;
    },
    withInstance: async (_candidate, _capability, use) => {
      try {
        return await use(execution);
      } finally {
        released = true;
      }
    },
  });
  try {
    await assert.rejects(
      () => operation.execute(input, context),
      (error) => {
        if (error !== stopped) throw error;
        return true;
      },
    );
    assert.equal(released, true);
    return object(
      JSON.parse(await readFile(join(directory, 'evaluator.json'), 'utf8')),
    );
  } finally {
    await operation.dispose();
  }
}
