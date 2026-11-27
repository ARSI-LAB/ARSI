import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { outputInstructions } from '../shared/native-agent/result.js';
import { withAgentExecutionTimeout } from '../shared/agent-timeout.js';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
  Operation,
} from '../../contracts/index.js';
import { checkOpenCodeAgent } from './doctor.js';

import type { AgentOpenCodeConfig } from './schema.js';
import { runSession } from './session.js';

export const createAgentOpenCode: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentOpenCodeConfig
>['create'] = async (config, ctx) => {
  ctx.event?.on('rsi/doctor', checkOpenCodeAgent);
  const operation: Operation<AgentInput, AgentOutput> = {
    async execute(request, context) {
      if (request.role !== undefined)
        throw new Error(
          'OpenCode role dispatch is not supported by this adapter; use native delegation',
        );
      const temporary = await mkdtemp(join(context.directory, 'opencode-'));
      try {
        const instructionPath = join(temporary, 'output-instructions.md');
        await writeFile(
          instructionPath,
          'Treat task input files as read-only.\n\n' +
            outputInstructions(request.outputSchema) +
            '\n',
          { mode: 0o600, flag: 'wx' },
        );
        return await runSession({
          config,
          directory: request.cwd,
          instructionPath,
          request,
          signal: context.signal,
          launch: (spec, onLine) => context.runAgentProcess(spec, onLine),
          record: (observation) =>
            context.event.emit('rsi/agent-observation', observation),
        });
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
    async dispose() {},
  };
  return withAgentExecutionTimeout(operation, config.timeoutMs);
};
