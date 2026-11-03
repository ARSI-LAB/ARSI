import type { JsonObject, JsonValue } from '../../../contracts/index.js';
export type NativeEvaluatorConfig = {
  services: JsonObject;
  benchmark: string | JsonObject;
  environment?: string | JsonObject;
  scheduler?: string | JsonObject;
  store?: string | JsonObject;
  reporter?: string | JsonObject;
  metrics?: JsonValue[];
  run?: JsonObject;
  deployment?: JsonObject;
  output?: JsonObject;
};
const nonempty: JsonObject = { type: 'string', minLength: 1 };
export const nativeConfigProperties: JsonObject = {
  services: { type: 'object', minProperties: 1 },
  benchmark: { oneOf: [nonempty, { type: 'object' }] },
  environment: { type: ['string', 'object'] },
  scheduler: { type: ['string', 'object'] },
  store: { type: ['string', 'object'] },
  reporter: { type: ['string', 'object'] },
  metrics: { type: 'array' },
  run: { type: 'object' },
  deployment: { type: 'object' },
  output: { type: 'object' },
};
