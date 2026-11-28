import { withAgentExecutionTimeout } from '../shared/agent-timeout.js';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
  Operation,
} from '../../contracts/index.js';
import { checkClaudeCodeAgent } from './doctor.js';

import type { AgentClaudeCodeConfig } from './schema.js';
import { runSession } from './session.js';
import { requireClaudeCodeVersion } from './version.js';

export const createAgentClaudeCode: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentClaudeCodeConfig
>['create'] = async (config, ctx) => {
  ctx.event?.on('rsi/doctor', checkClaudeCodeAgent);
  const operation: Operation<AgentInput, AgentOutput> = {
    async execute(request, context) {
      if (request.role !== undefined)
        throw new Error('For Claude Code role delegation, use native Agent');
      const probe = context.extend({
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(5000)]),
      });
      await requireClaudeCodeVersion(
        config.executable ?? 'claude',
        (spec, onLine) => probe.runAgentProcess(spec, onLine),
      );
      probe.signal.throwIfAborted();
      return runSession({
        config,
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
