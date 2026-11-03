import type {
  ApplicationInput,
  ApplicationOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { configSchema, type InferenceConfig } from './schema.js';
import { applicationContract } from '../../contracts/plugin-types/index.js';
import { createApplicationInference } from './service.js';
export const inferenceDefinition: OperationDefinition<
  ApplicationInput,
  ApplicationOutput,
  InferenceConfig
> = {
  id: 'application.inference',
  description:
    'Manage inference configuration candidates and inference instances.',
  contract: applicationContract,
  configSchema,
  create: createApplicationInference,
};
