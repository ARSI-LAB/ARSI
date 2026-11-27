import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { AgentInput, RuntimeContext } from '../../../contracts/index.js';
import {
  assertOwnedAgentProject,
  publishAgentProject,
} from '../../../runtime/services/agent-project.js';
import { directoryFingerprint } from '../../../runtime/storage/directory-fingerprint.js';
import { outputInstructions } from '../agent-output-instructions.js';

export async function prepareNativeOutputProject(
  request: AgentInput,
  context: RuntimeContext,
): Promise<{ directory: string; instructionBytes: number }> {
  const owner = dirname(dirname(dirname(request.cwd)));
  await assertOwnedAgentProject(owner, request.cwd);
  const snapshot = 'artifact:' + basename(dirname(request.cwd));
  const staging = await mkdtemp(join(owner, 'native-project-'));
  try {
    await context.artifacts.materialize(snapshot, staging);
    const instructions =
      'Treat task input files as read-only.\n\n' +
      outputInstructions(request.outputSchema) +
      '\n\n';
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      const path = join(staging, file);
      await writeFile(path, instructions + (await readFile(path, 'utf8')));
    }
    context.signal.throwIfAborted();
    // DSH sessions can only be adopted from the directory recorded at creation.
    const directory = await publishAgentProject(
      staging,
      owner,
      context.artifacts,
      async (existing) => {
        if (
          (await directoryFingerprint(existing)) !==
          (await directoryFingerprint(staging))
        )
          throw new Error('Native Agent project changed');
      },
    );
    return { directory, instructionBytes: Buffer.byteLength(instructions) };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
