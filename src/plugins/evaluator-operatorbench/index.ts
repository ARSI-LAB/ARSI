import type { OperationDefinition } from '../../contracts/index.js';
import {
  operatorbenchContract,
  type OperatorbenchInput,
  type OperatorbenchOutput,
} from '../../contracts/plugin-types/operatorbench.js';
import { configSchema, type OperatorbenchConfig } from './schema.js';
import { createOperatorbench } from './service.js';

export { createOperatorbench };

export const operatorbenchDefinition: OperationDefinition<
  OperatorbenchInput,
  OperatorbenchOutput,
  OperatorbenchConfig
> = {
  id: 'evaluator.operatorbench',
  contract: operatorbenchContract,
  configSchema,
  create: createOperatorbench,
};
