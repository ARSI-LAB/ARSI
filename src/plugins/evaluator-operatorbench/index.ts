import { cleanupEvaluatorBinding } from '../shared/evaluator-adapter/cleanup.js';
import type {
  OperationDefinition,
  OperationEvents,
} from '../../contracts/index.js';
import {
  operatorbenchContract,
  type OperatorbenchInput,
  type OperatorbenchOutput,
} from '../../contracts/plugin-types/operatorbench.js';
import {
  operatorbenchConfigSchema,
  type OperatorbenchConfig,
} from './schema.js';
import { createOperatorbench } from './service.js';
import { operatorbenchDoctor } from './doctor.js';

export { createOperatorbench };

export const operatorbenchDefinition: OperationDefinition<
  OperatorbenchInput,
  OperatorbenchOutput,
  OperatorbenchConfig
> = {
  id: 'evaluator.operatorbench',
  contract: operatorbenchContract,
  configSchema: operatorbenchConfigSchema,
  create: createOperatorbench,
};

export function operatorbenchEvents(
  events: OperationEvents<OperatorbenchConfig>,
): void {
  events.on('rsi/doctor', operatorbenchDoctor);
  events.on('rsi/cleanup', (context) =>
    cleanupEvaluatorBinding(context, 'kernel'),
  );
}
