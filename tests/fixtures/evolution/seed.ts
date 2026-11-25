import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FileFacts,
  FileArtifacts,
} from '../../../src/runtime/storage/index.js';
import {
  RevisionApplication,
  MemoryApplication,
} from '../../../src/runtime/evolution/application.js';

/** Real revision application against disposable resources, never repository guidance. */
export async function seedEvolution(root: string) {
  root = await realpath(root);
  const directory = join(root, 'runtime');
  const project = join(root, 'project');
  const guidance = join(project, 'guidance');
  await mkdir(guidance, { recursive: true });
  await writeFile(join(guidance, 'checks.md'), 'Validate the output.\n');
  const facts = new FileFacts(join(directory, 'facts'));
  const artifacts = new FileArtifacts(join(directory, 'artifacts'));
  const application = new RevisionApplication({
    directory,
    rootDirectory: project,
    facts,
    artifacts,
  });
  await facts.write('experiments', 'evolution-run', {
    id: 'evolution-run',
    recipeId: 'harness2-office',
    status: 'succeeded',
    startedAt: '2026-11-05T01:00:00.000Z',
    finishedAt: '2026-11-05T01:30:00.000Z',
    recipe: { config: { api_key: 'evolution-secret-value' } },
  });
  await facts.write('experiments', 'other-run', {
    id: 'other-run',
    status: 'succeeded',
  });
  const prefix = 'resources/proposer/guidance';
  const tree = async (path: string, text: string) =>
    artifacts.putJson({
      kind: 'file-tree',
      files: [
        { path, mode: 0o644, base64: Buffer.from(text).toString('base64') },
      ],
    });
  const before = await tree(`${prefix}/checks.md`, 'Validate the output.\n');
  const after = await tree(
    `${prefix}/checks.md`,
    'Validate the output.\nReopen the workbook and verify formula results.\n',
  );
  for (const [ref, resourceRef] of [
    ['revision-initial', before],
    ['revision-next', after],
  ]) {
    await facts.write('revisions', ref!, {
      ref: ref!,
      experimentId: 'evolution-run',
      bindings: ['proposer', 'summarizer'],
      ...(ref === 'revision-next'
        ? { changedBindings: ['proposer', 'summarizer'] }
        : {}),
      policyScopeId: 'root',
      rootRef: 'revision-initial',
      parentRef: ref === 'revision-initial' ? null : 'revision-initial',
      kind: ref === 'revision-initial' ? 'initial' : 'generated',
      status: 'validated',
      resourceRef: resourceRef!,
      sourceRoots: [
        {
          kind: 'directory',
          path: guidance,
          artifactPath: prefix,
          members: [
            {
              binding: 'proposer',
              pointer: '/guidance',
              kind: 'directory',
              relativePath: '',
            },
            {
              binding: 'summarizer',
              pointer: '/promptFile',
              kind: 'file',
              relativePath: 'checks.md',
            },
          ],
        },
      ],
      reason:
        ref === 'revision-initial'
          ? null
          : 'Verify saved formula results before delivery. evolution-secret-value',
    });
  }
  const memoryBefore = await tree(
    'experience.md',
    'Preserve worksheet names.\n',
  );
  const memoryAfter = await tree(
    'experience.md',
    'Preserve worksheet names.\nCheck formula results after saving.\n',
  );
  const memoryApplication = new MemoryApplication({
    directory,
    rootDirectory: project,
    facts,
    artifacts,
  });
  for (const [ref, artifactRef] of [
    ['memory-initial', memoryBefore],
    ['memory-next', memoryAfter],
  ] as const)
    await facts.write('memory-revisions', ref, {
      ref,
      artifactRef,
      experimentId: 'evolution-run',
      rootRef: 'memory-initial',
      parentRef: ref === 'memory-initial' ? null : 'memory-initial',
      kind: ref === 'memory-initial' ? 'initial' : 'generated',
      ...(ref === 'memory-initial'
        ? { sourceDirectory: null, status: 'initial' }
        : { evolutionId: 'memory-run', status: 'validated' }),
    });
  await facts.write('evolution-runs', 'memory-run', {
    experimentId: 'evolution-run',
    kind: 'memory',
    evolutionId: 'memory-run',
    triggerPath: 'steps/search/iteration-1',
    callId: 'memory-update',
    status: 'activated',
    startedAt: '2026-11-05T01:15:00.000Z',
  });
  await facts.write('calls', 'memory-update', {
    experimentId: 'evolution-run',
    callId: 'memory-update',
    bindingId: '_memory',
    pluginId: 'custom.memory',
    status: 'succeeded',
    path: 'evolution/memory-run',
  });
  return {
    directory,
    guidance,
    facts,
    artifacts,
    application,
    memoryApplication,
    before,
    after,
    memoryBefore,
    memoryAfter,
  };
}
