import {
  parseUserConfig as parseSdkConfig,
  type UserConfig as SdkEvaluatorConfig,
  type ServiceInput,
} from 'ember-evaluator';
import type { JsonObject, JsonValue } from '../../../contracts/index.js';

export type { SdkEvaluatorConfig };

/** SDK configuration persisted as RSI JSON; no parallel field definitions. */
export type EvaluatorConfig = {
  [K in keyof SdkEvaluatorConfig]: SdkEvaluatorConfig[K] & JsonValue;
};
/** Recipe input for plugins that bind the SDK service at evaluation time. */
export type BoundServiceConfig = Omit<EvaluatorConfig, 'services'> & {
  services?: Record<string, Partial<ServiceInput>>;
};
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
