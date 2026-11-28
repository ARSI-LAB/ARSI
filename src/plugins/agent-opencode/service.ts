import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withAgentExecutionTimeout } from '../shared/agent-timeout.js';
import type {
  AgentInput,
  AgentOutput,
  OperationDefinition,
  Operation,
} from '../../contracts/index.js';
import { checkOpenCodeAgent } from './doctor.js';
import {
  prepareOpenCodeProject,
  taskInstructions,
  taskInstructionsVariable,
} from './project.js';

import type { AgentOpenCodeConfig } from './schema.js';
import {
  addInlineInstructions,
  launchEnvironment,
  runSession,
} from './session.js';

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
      const run = (directory: string, env: NodeJS.ProcessEnv) => {
        context.signal.throwIfAborted();
        const scope = context.extend({ agentProject: directory });
        return runSession({
          config,
          env,
          request,
          signal: scope.signal,
          launch: (spec, onLine) => scope.runAgentProcess(spec, onLine),
          record: (observation) =>
            scope.event.emit('rsi/agent-observation', observation),
        });
      };
      const projectConfigDisabled = /^(?:1|true)$/i.test(
        process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? '',
      );
      const continuingSession = (config.options ?? []).some((option) =>
        /^(?:--(?:continue|session)(?:=|$)|-[cs])/.test(option),
      );
      const temporary = await mkdtemp(join(context.directory, 'opencode-'));
      try {
        const instructionPath = join(temporary, 'output-instructions.md');
        await writeFile(instructionPath, taskInstructions(request), {
          mode: 0o600,
          flag: 'wx',
        });
        const instructionEnv = {
          [taskInstructionsVariable]: JSON.stringify(instructionPath).slice(
            1,
            -1,
          ),
        };
        const env: NodeJS.ProcessEnv = {
          ...launchEnvironment(request.cwd),
          ...instructionEnv,
        };
        const instructions = [join(request.cwd, 'AGENTS.md'), instructionPath];
        const inlineEnv =
          continuingSession && env.OPENCODE_CONFIG
            ? addInlineInstructions(env, instructions)
            : undefined;
        // Native continuation can restore an earlier cwd, so prefer a global layer when possible.
        if (inlineEnv) return await run(request.cwd, inlineEnv);
        if (
          !projectConfigDisabled &&
          (!continuingSession || env.OPENCODE_CONFIG)
        ) {
          const directory = await prepareOpenCodeProject(request, context);
          if (directory !== undefined)
            return await run(directory, {
              ...launchEnvironment(directory),
              ...instructionEnv,
            });
        }

        // Preserve an existing custom config even when the project layer is unavailable.
        if (env.OPENCODE_CONFIG) {
          const fallback = addInlineInstructions(env, instructions);
          if (!fallback)
            throw new Error(
              'OpenCode needs a native configuration layer to add the output Schema. Enable project configuration with a free config file slot or leave OPENCODE_CONFIG unset if inline config requires native substitutions.',
            );
          return await run(request.cwd, fallback);
        }
        const nativeConfig = join(temporary, 'opencode.json');
        await writeFile(nativeConfig, JSON.stringify({ instructions }), {
          mode: 0o600,
          flag: 'wx',
        });
        return await run(request.cwd, {
          ...env,
          OPENCODE_CONFIG: nativeConfig,
        });
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
    async dispose() {},
  };
  return withAgentExecutionTimeout(operation, config.timeoutMs);
};
