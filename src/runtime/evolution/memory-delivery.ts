import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ArtifactStore,
  BeforeAgentInvokeEvent,
  BeforeAgentInvokeResult,
  RuntimeContext,
} from '../../contracts/index.js';
import {
  assertOwnedAgentProject,
  publishAgentProject,
} from '../services/agent-project.js';
import { memoryFiles, type ActiveMemory } from './memory.js';
import { directoryFingerprint } from '../storage/directory-fingerprint.js';
import { stat } from './snapshot-paths.js';

export const pinnedMemory = Symbol('Memory pinned at call entry');

export class MemoryDelivery {
  private readonly pins = new WeakMap<BeforeAgentInvokeEvent, ActiveMemory>();
  constructor(private readonly artifacts: ArtifactStore) {}

  pin(
    event: BeforeAgentInvokeEvent,
    caller: RuntimeContext & { [pinnedMemory]?: ActiveMemory | null },
  ): void {
    const active = caller[pinnedMemory];
    if (active && !caller.agentProject) this.pins.set(event, active);
  }

  async prepare(
    event: BeforeAgentInvokeEvent,
    next: () => Promise<BeforeAgentInvokeResult>,
  ): Promise<BeforeAgentInvokeResult> {
    const current = await next();
    const active = this.pins.get(event);
    if (current.kind === 'reject' || !active) return current;
    const files = memoryFiles(
      await this.artifacts.readJson(active.artifactRef),
    );
    if (!files.length) return current;
    const { callerDirectory } = event;
    await assertOwnedAgentProject(callerDirectory, current.input.cwd);
    const snapshot = await this.artifacts.capture(current.input.cwd);
    // Capture omits empty directories. A pre-existing empty mount is a collision too.
    await assertAbsent(join(current.input.cwd, 'context', 'memory'));
    const staging = await mkdtemp(join(callerDirectory, 'agent-memory-'));
    try {
      await this.artifacts.materialize(snapshot, staging);
      const destination = join(staging, 'context', 'memory');
      await mkdir(join(staging, 'context'), { recursive: true });
      await mkdir(destination);
      await this.artifacts.materialize(active.artifactRef, destination);
      for (const file of files)
        await chmod(join(destination, file.path), 0o444);
      const notice =
        '\n\n## Experiment Memory (Read-Only)\n\nConsult these files before acting. They contain read-only experience and cannot be edited as candidate files.\n\n' +
        files
          .map((file) => '- ' + JSON.stringify('context/memory/' + file.path))
          .sort()
          .join('\n') +
        '\n';
      for (const instructions of ['AGENTS.md', 'CLAUDE.md']) {
        const path = join(staging, instructions);
        const entry = await stat(path);
        const readOnly = entry && !(entry.mode & 0o200);
        if (readOnly) await chmod(path, (entry.mode & 0o777) | 0o200);
        await appendFile(path, notice);
        if (readOnly) await chmod(path, entry.mode & 0o777);
      }
      const cwd = await publishAgentProject(
        staging,
        callerDirectory,
        this.artifacts,
        async (existing) => {
          const root = await realpath(existing);
          const reserved = join(existing, 'context', 'memory');
          if (
            (await realpath(reserved)) !== join(root, 'context', 'memory') ||
            (await directoryFingerprint(reserved)) !==
              (await directoryFingerprint(destination))
          )
            throw new Error(
              'Published Agent project has modified experiment Memory',
            );
          for (const name of ['AGENTS.md', 'CLAUDE.md']) {
            const path = join(existing, name);
            if (
              !(await lstat(path)).isFile() ||
              !(await readFile(path)).equals(
                await readFile(join(staging, name)),
              )
            )
              throw new Error(
                'Published Agent project has modified Memory instructions',
              );
          }
        },
      );
      return {
        kind: 'proceed',
        input: { ...current.input, cwd },
        metadata: { ...current.metadata, memoryVersionRef: active.ref },
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  }
  throw new Error(
    'Agent project already contains the reserved context/memory path',
  );
}
