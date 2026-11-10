import type {
  ApplicationInput,
  ApplicationOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { applicationContract } from '../../contracts/plugin-types/index.js';
import { configSchema, type KernelApplicationConfig } from './schema.js';
import { createApplicationKernel } from './service.js';
import { checkFileApplication } from '../../runtime/doctor/application-checks.js';

export { createApplicationKernel } from './service.js';
export type { KernelApplicationConfig } from './schema.js';

export const kernelApplicationDefinition: OperationDefinition<
  ApplicationInput,
  ApplicationOutput,
  KernelApplicationConfig
> = {
  id: 'application.kernel',
  contract: applicationContract,
  configSchema,
  create: createApplicationKernel,
  doctor: checkFileApplication,
};
