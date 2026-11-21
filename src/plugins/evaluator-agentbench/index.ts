import { cleanupEvaluatorBinding } from '../shared/evaluator-adapter/cleanup.js';
import type {
  AgentbenchInput,
  AgentbenchOutput,
  OperationDefinition,
  OperationEvents,
} from '../../contracts/index.js';
import { configSchema, type AgentbenchConfig } from './schema.js';
import { agentbenchContract } from '../../contracts/plugin-types/index.js';
import { createAgentbench } from './service.js';
import { agentbenchDoctor } from './doctor.js';
export const agentbenchDefinition: OperationDefinition<
  AgentbenchInput,
  AgentbenchOutput,
  AgentbenchConfig
> = {
  id: 'evaluator.agentbench',
  description: 'Measure agent instances with the Evaluator SDK AgentBench.',
  contract: agentbenchContract,
  configSchema,
  create: createAgentbench,
};

export function agentbenchEvents(
  events: OperationEvents<AgentbenchConfig>,
): void {
  events.on('rsi/doctor', agentbenchDoctor);
  events.on('rsi/cleanup', (context) =>
    cleanupEvaluatorBinding(context, 'agentbundle'),
  );
}
