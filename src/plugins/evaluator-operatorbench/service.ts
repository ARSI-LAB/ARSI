import type { Operation, RuntimeContext } from '../../contracts/index.js';
import type {
  OperatorbenchInput,
  OperatorbenchOutput,
} from '../../contracts/plugin-types/operatorbench.js';
import { parseConfig } from '../../shared/schema.js';
import { configSchema, type OperatorbenchConfig } from './schema.js';
import { createSdkOperatorbench } from './sdk-service.js';

export async function createOperatorbench(
  rawConfig: unknown,
  services: RuntimeContext,
): Promise<Operation<OperatorbenchInput, OperatorbenchOutput>> {
  const config = parseConfig<OperatorbenchConfig>(
    configSchema,
    rawConfig,
    'operatorbench config',
  );
  return createSdkOperatorbench(config, services);
}
