import type { JsonObject } from '../../contracts/index.js';
import { recordSchema } from '../../contracts/models/measurement.js';
import { object } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { OperatorModelOutputError } from './agent.js';

export const operatorEditConstraints = {
  allowedPaths: ['input.py'],
  maxChangedFiles: 1,
  maxChangedBytes: 32768,
};
export const operatorEditOutputSchema = recordSchema({
  edits: {
    type: 'array',
    maxItems: 1,
    items: recordSchema({
      path: { const: 'input.py' },
      content: { type: 'string', maxLength: 32768 },
    }),
  },
  reason: { type: 'string', maxLength: 4000 },
});
/** Validate model data before allocating a mutable workspace; writes enforce these bounds again. */
export function validateOperatorEdits(response: JsonObject): void {
  try {
    validate(operatorEditOutputSchema, response, 'Operator edits');
    const edits = response.edits;
    if (
      Array.isArray(edits) &&
      edits.some(
        (raw) =>
          Buffer.byteLength(String(object(raw).content)) >
          operatorEditConstraints.maxChangedBytes,
      )
    )
      throw new Error('Operator edit exceeds byte limit');
  } catch (error) {
    throw new OperatorModelOutputError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}
