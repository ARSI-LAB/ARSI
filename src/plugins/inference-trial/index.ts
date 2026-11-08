import type { OperationDefinition } from '../../contracts/index.js';
import {
  inferenceTrialContract,
  type InferenceTrialInput,
  type InferenceTrialOutput,
} from '../../contracts/plugin-types/inference-trial.js';
import { configSchema } from './schema.js';
import { createInferenceTrial } from './service.js';

export const inferenceTrialDefinition: OperationDefinition<
  InferenceTrialInput,
  InferenceTrialOutput
> = {
  id: 'inference.trial',
  description:
    'Evaluate an inference candidate and classify confirmed startup rejections.',
  contract: inferenceTrialContract,
  configSchema,
  create: createInferenceTrial,
};
