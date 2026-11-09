import type {
  MetricSelectorInput,
  MetricSelectorOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { metricSelectorContract } from '../../contracts/plugin-types/index.js';
import { configSchema, type MetricSelectorConfig } from './schema.js';
import { createInferenceSelector } from './service.js';

export const inferenceSelectorDefinition: OperationDefinition<
  MetricSelectorInput,
  MetricSelectorOutput,
  MetricSelectorConfig
> = {
  id: 'selector.inference',
  description:
    'Improve inference constraint feasibility before optimizing performance.',
  contract: metricSelectorContract,
  configSchema,
  create: createInferenceSelector,
};
