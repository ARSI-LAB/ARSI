import { checkStaticFileApplication } from '../shared/file-application/doctor.js';
import type {
  ApplicationInput,
  ApplicationOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { configSchema, type InferenceConfig } from './schema.js';
import { applicationContract } from '../../contracts/plugin-types/index.js';
import { createApplicationInference } from './service.js';
import { checkInferenceApplication } from './doctor.js';
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
  staticDoctor: checkStaticFileApplication,
  create: createApplicationInference,
  doctor: checkInferenceApplication,
};
