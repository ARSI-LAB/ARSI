import { withAgentExecutionTimeout } from '../shared/agent-timeout.js';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
  Operation,
} from '../../contracts/index.js';
import { checkCodexAgent } from './doctor.js';

import type { AgentCodexConfig } from './schema.js';
import { runSession } from './session.js';

export const createAgentCodex: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentCodexConfig
>['create'] = async (config, ctx) => {
  ctx.event?.on('rsi/doctor', checkCodexAgent);
  const operation: Operation<AgentInput, AgentOutput> = {
    async execute(request, context) {
      if (request.role !== undefined)
        throw new Error('For Codex role delegation, use native spawn_agent');
      return runSession({
        executable: config.executable ?? 'codex',
        options: config.options ?? [],
        directory: request.cwd,
        request,
        signal: context.signal,
        launch: (spec, onLine) => context.runAgentProcess(spec, onLine),
        record: (observation) =>
          context.event.emit('rsi/agent-observation', observation),
      });
    },
    async dispose() {},
  };
  return withAgentExecutionTimeout(operation, config.timeoutMs);
};
