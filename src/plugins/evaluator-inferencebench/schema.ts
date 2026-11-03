import type { JsonObject } from '../../contracts/index.js';
import {
  nativeConfigProperties,
  type NativeEvaluatorConfig,
} from '../shared/evaluator-adapter/configuration-schema.js';
export type InferencebenchConfig = NativeEvaluatorConfig;
export const configSchema: JsonObject = {
  type: 'object',
  properties: { ...nativeConfigProperties },
  required: ['services', 'benchmark'],
  additionalProperties: false,
};
