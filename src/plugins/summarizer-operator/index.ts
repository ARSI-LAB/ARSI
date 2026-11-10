import type {
  OperationDefinition,
  OperatorSummarizerInput,
  OperatorSummarizerOutput,
} from '../../contracts/index.js';
import { operatorSummarizerContract } from '../../contracts/plugin-types/summarizer-operator.js';
import { configSchema, type OperatorSummarizerConfig } from './schema.js';
import { createOperatorSummarizer } from './service.js';
export { createOperatorSummarizer };
export const operatorSummarizerDefinition: OperationDefinition<
  OperatorSummarizerInput,
  OperatorSummarizerOutput,
  OperatorSummarizerConfig
> = {
  id: 'summarizer.operator',
  contract: operatorSummarizerContract,
  configSchema,
  create: createOperatorSummarizer,
};
