import {
  parseUserConfig as parseSdkConfig,
  type UserConfig as SdkEvaluatorConfig,
  type ServiceInput,
} from 'ember-evaluator';
import type { JsonObject, JsonValue } from '../../../contracts/index.js';

export type { SdkEvaluatorConfig };

/** SDK options in a JSON Recipe. A plugin may supply service fields at execution. */
export type EvaluatorConfig = {
  [K in keyof Omit<SdkEvaluatorConfig, 'services'>]: SdkEvaluatorConfig[K] &
    JsonValue;
} & { services?: Record<string, Partial<ServiceInput>> };
export const configSchema: JsonObject = { type: 'object' };

export function parseEvaluatorConfig(value: unknown): SdkEvaluatorConfig {
  const config = parseSdkConfig(value);
  // RSI persists the input before SDK execution; reject literal secrets before writing.
  for (const service of Object.values(config.services)) {
    if (
      service.api_key !== undefined &&
      !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(service.api_key)
    )
      throw new Error('services api_key must be an environment reference');
  }
  return config;
}
