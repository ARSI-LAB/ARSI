import { withAgentExecutionTimeout } from '../shared/agent-timeout.js';
import { observeNative } from '../shared/native-agent/observe.js';
import { parseAgentResult } from '../shared/native-agent/result.js';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
  Operation,
} from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { checkDshAgent } from './doctor.js';

import type { AgentDshConfig } from './schema.js';
import { runDshProcess } from './process.js';
import { dshObservations } from './observations.js';

export const createAgentDsh: OperationDefinition<
  AgentInput,
  AgentOutput,
  AgentDshConfig
>['create'] = async (config, ctx) => {
  ctx.event?.on('rsi/doctor', checkDshAgent);
  const operation: Operation<AgentInput, AgentOutput> = {
    async execute(request, context) {
      if (request.role !== undefined)
        throw new Error('For DSH role delegation, use native subagents');
      const launch: import('../../contracts/index.js').AgentProcessLauncher = (
        spec,
        onLine,
      ) => context.runAgentProcess(spec, onLine);
      const patch = join(context.directory, 'dsh-launch.json');
      await writeFile(
        patch,
        JSON.stringify([
          ...['credentials', 'authorization', 'deepseek-account'].map((id) => ({
            id,
            disabled: false,
          })),
          {
            id: 'agent-instructions',
            config: { maxBytes: 65536, projectRootMarkers: ['.rsi-project'] },
          },
          {
            id: 'skill-filesystem',
            config: {
              customSkillDirs: [join(request.cwd, '.agents', 'skills')],
            },
          },
        ]),
        { mode: 0o600 },
      );
      const record = (
        observation: import('../../contracts/index.js').AgentObservation,
      ): void => {
        context.event.emit('rsi/agent-observation', observation);
      };
      const observe = observeNative(
        dshObservations(record),
        record,
        context.signal,
      );
      let sessionId: string | undefined;
      let finalText: string | undefined;
      try {
        const prompt =
          JSON.stringify({
            goal: request.goal,
            instruction:
              'Read AGENTS.md and follow the project instructions. Use native subagents for delegation, reading roles/<name>.md when a role is listed. The project is read-only; return proposed edits in the requested JSON rather than modifying files. Return only the JSON object matching outputSchema in your final answer.',
            outputSchema: request.outputSchema,
          }) +
          '\n\nAfter completing the task, your final response MUST be only the JSON object matching outputSchema above. Do not summarize your work in prose or Markdown. A prose response is a failed task.';
        await runDshProcess(
          config.executable ?? 'dsh',
          config.options ?? [],
          patch,
          prompt,
          (line) => {
            const event = object(JSON.parse(line));
            observe(event);
            if (event.type === 'session') {
              if (sessionId !== undefined)
                throw new Error('DSH emitted duplicate session events');
              sessionId = string(event.sessionId);
            } else if (event.type === 'error') {
              record({
                runId: 'main',
                ...(sessionId ? { native: { sessionId } } : {}),
                event: {
                  type: 'run.finished',
                  status: 'failed',
                  nativeStatus: 'error',
                  error: String(event.message),
                },
              });
              throw new Error(`DSH execution failed: ${String(event.message)}`);
            } else if (event.type === 'final') {
              if (
                !sessionId ||
                event.sessionId !== sessionId ||
                finalText !== undefined
              )
                throw new Error('Invalid DSH final session');
              const reason = object(event.reason).kind;
              record({
                runId: 'main',
                native: { sessionId },
                event: {
                  type: 'run.finished',
                  status: reason === 'completed' ? 'completed' : 'unknown',
                  ...(typeof reason === 'string'
                    ? { nativeStatus: reason }
                    : {}),
                },
              });
              if (reason !== 'completed')
                throw new Error('DSH task did not complete');
              finalText = string(event.text);
            }
          },
          launch,
          { record, outputSchema: request.outputSchema },
        );
        if (finalText === undefined)
          throw new Error('DSH returned no final result');
        return parseAgentResult(finalText);
      } finally {
        await rm(patch, { force: true });
      }
    },
    async dispose() {},
  };
  return withAgentExecutionTimeout(operation, config.timeoutMs);
};
