import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AgentEditingConfig } from './schema.js';
import type {
  MemoryInput,
  MemoryOutput,
  OperationDefinition,
  RuntimeContext,
} from '../../contracts/index.js';
import { json, string } from '../../shared/json.js';
import {
  editResource,
  resourceFiles,
  seedMemoryRef,
} from '../shared/agent-editing/index.js';
import { buildComparisonContext } from './comparison.js';
import { errorText } from '../../shared/errors.js';

// Directory fields may reference the environment; `${VAR}` resolution for
// seeding lives in the shared seedMemoryRef.
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function resolveDirectory(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  const resolved = value.replace(ENV_REFERENCE, (_match, name: string) => {
    const replacement = process.env[name];
    if (replacement === undefined)
      throw new Error(
        `memory.agent ${field} references missing environment variable ${name}`,
      );
    return replacement;
  });
  if (!resolved.trim())
    throw new Error(`memory.agent ${field} resolved to an empty value`);
  return resolved;
}

async function persistMemory(
  ref: string,
  directory: string,
  context: RuntimeContext,
): Promise<void> {
  const files = await resourceFiles(ref, context);
  const root = resolve(directory);
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== 'string') continue;
    const target = resolve(root, path);
    if (target !== root && !target.startsWith(root + '/'))
      throw new Error(`memory file escapes the persist directory: ${path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export const createMemoryAgent: OperationDefinition<
  MemoryInput,
  MemoryOutput,
  AgentEditingConfig
>['create'] = async (config, _context) => {
  return {
    async canRetry(_input, receipt, context) {
      if (
        receipt.status !== 'failed' ||
        receipt.experimentId !== context.experimentId ||
        typeof receipt.callId !== 'string' ||
        !receipt.callId
      )
        return false;
      // Evidence preparation is read-only. Editing and artifact capture occur only
      // after invokeAgent, whose child receipt is persisted before model execution.
      return !(await context.facts.list('calls')).some(
        (call) => call.parentCallId === receipt.callId,
      );
    },
    async execute(input, context) {
      json(input);
      try {
        const seeded =
          input.memoryRef === null
            ? await seedMemoryRef(config, context)
            : string(input.memoryRef);
        const comparison =
          input.comparison === undefined
            ? undefined
            : await buildComparisonContext(input, context);
        const updated = await editResource(
          config,
          input,
          seeded,
          context,
          comparison,
        );
        if (updated.changeRef !== null) {
          const memoryRef = string(updated.resourceRef);
          const persistDirectory = resolveDirectory(
            config.persistDirectory,
            'persistDirectory',
          );
          if (persistDirectory)
            await persistMemory(memoryRef, persistDirectory, context);
          return {
            status: 'updated',
            memoryRef,
            changeRef: updated.changeRef,
            reason: updated.reason,
          };
        }
        return {
          status: 'no-change',
          memoryRef: updated.resourceRef,
          changeRef: null,
          reason: updated.reason,
        };
      } catch (error) {
        if (
          context.signal.aborted ||
          (error instanceof Error && error.name === 'ExperimentBudgetExceeded')
        )
          throw error;
        return {
          status: 'failed',
          memoryRef: input.memoryRef,
          changeRef: null,
          reason: errorText(error),
        };
      }
    },
    async dispose() {},
  };
};
