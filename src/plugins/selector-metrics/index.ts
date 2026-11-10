import type {
  MetricSelectorInput,
  MetricSelectorOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { configSchema, type MetricSelectorConfig } from './schema.js';
import { metricSelectorContract } from '../../contracts/plugin-types/index.js';
import { createMetricSelector } from './service.js';
import { checkOperationConfiguration } from '../../runtime/doctor/business-checks.js';
export const metricSelectorDefinition: OperationDefinition<
  MetricSelectorInput,
  MetricSelectorOutput,
  MetricSelectorConfig
> = {
  id: 'selector.metric',
  description: 'Select candidates using recorded metrics.',
  contract: metricSelectorContract,
  configSchema,
  create: createMetricSelector,
  doctor: checkOperationConfiguration,
};
