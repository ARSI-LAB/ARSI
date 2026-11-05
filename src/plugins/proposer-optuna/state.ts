import type { JsonObject, JsonSchema } from '../../contracts/index.js';
import { parseConfig } from '../../shared/schema.js';
export type SearchTrial = {
  parameters: JsonObject;
  status: 'pending' | 'complete' | 'duplicate';
  candidateRef: string | null;
  measurementRef: string | null;
  decisionRef: string | null;
  loss: number | null;
  constraints: number[];
};
export type SearchState = {
  schemaVersion: 'rsi.parameter-search/v1';
  experimentId: string;
  bindingId: string;
  parent: string;
  configuration: string;
  settings: JsonObject;
  workerDigest: string;
  environment: JsonObject;
  objectiveIdentity: JsonObject | null;
  comparisonKey: string | null;
  history: SearchTrial[];
};
const ref = { type: 'string', minLength: 1 };
const optionalRef = { type: ['string', 'null'] };
const shape = (properties: JsonObject): JsonObject => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const stateSchema: JsonSchema = shape({
  schemaVersion: { const: 'rsi.parameter-search/v1' },
  experimentId: ref,
  bindingId: ref,
  parent: ref,
  configuration: ref,
  settings: { type: 'object' },
  workerDigest: ref,
  environment: { type: 'object' },
  objectiveIdentity: { type: ['object', 'null'] },
  comparisonKey: optionalRef,
  history: {
    type: 'array',
    items: shape({
      parameters: { type: 'object' },
      status: { enum: ['pending', 'complete', 'duplicate'] },
      candidateRef: optionalRef,
      measurementRef: optionalRef,
      decisionRef: optionalRef,
      loss: { type: ['number', 'null'] },
      constraints: { type: 'array', items: { type: 'number' } },
    }),
  },
});
export function parseSearchState(value: unknown): SearchState {
  return parseConfig<SearchState>(stateSchema, value, 'Parameter search state');
}
