import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { AgentInput, RuntimeContext } from '../../contracts/index.js';
import { assertOwnedAgentProject } from '../../shared/agent-project.js';
import { outputInstructions } from '../shared/native-agent/result.js';

export const taskInstructionsVariable = 'ARSI_OPENCODE_TASK_INSTRUCTIONS';

export async function prepareOpenCodeProject(
  request: AgentInput,
  context: RuntimeContext,
): Promise<string | undefined> {
  const owner = dirname(dirname(dirname(request.cwd)));
  await assertOwnedAgentProject(owner, request.cwd);
  const snapshot = 'artifact:' + basename(dirname(request.cwd));
  const directory = await mkdtemp(join(context.directory, 'opencode-project-'));
  let prepared = false;
  try {
    await context.artifacts.materialize(snapshot, directory);
    context.signal.throwIfAborted();
    prepared = await addProjectConfig(directory);
    // OpenCode records the cwd and requires it when continuing the native session.
    if (prepared) return directory;
  } finally {
    if (!prepared) await rm(directory, { recursive: true, force: true });
  }
}

async function addProjectConfig(directory: string): Promise<boolean> {
  // A resumed native session loads this config from its earlier project.
  const config = JSON.stringify({
    instructions: [
      join(directory, 'AGENTS.md'),
      `{env:${taskInstructionsVariable}}`,
    ],
  });
  for (const base of [directory, join(directory, '.opencode')]) {
    for (const name of ['opencode.json', 'opencode.jsonc']) {
      try {
        await mkdir(base, { recursive: true });
        await writeFile(join(base, name), config, { flag: 'wx' });
        return true;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          !['EEXIST', 'EISDIR', 'ENOTDIR'].includes(String(error.code))
        )
          throw error;
      }
    }
  }
  return false;
}

export function taskInstructions(request: AgentInput): string {
  return (
    'Treat task input files as read-only.\n\n' +
    outputInstructions(request.outputSchema) +
    '\n'
  );
}
