import type {
  ApplicationInput,
  ApplicationOutput,
  OperationDefinition,
  OperationEvents,
} from '../../contracts/index.js';
import { applicationContract } from '../../contracts/plugin-types/index.js';
import { configSchema, type KernelApplicationConfig } from './schema.js';
import { createApplicationKernel } from './service.js';
import { checkKernelApplication } from './doctor.js';

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
};

export function kernelApplicationEvents(
  events: OperationEvents<KernelApplicationConfig>,
): void {
  events.on('rsi/doctor', checkKernelApplication);
}
