import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FileFacts,
  FileArtifacts,
} from '../../../src/runtime/storage/index.js';
import { RevisionApplication } from '../../../src/runtime/revisions/application.js';

/** Real revision application against disposable resources, never repository guidance. */
export async function seedLearning(root: string) {
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
  await facts.write('experiments', 'learning-run', {
    id: 'learning-run',
    recipeId: 'harness2-office',
    status: 'succeeded',
    startedAt: '2026-11-05T01:00:00.000Z',
    finishedAt: '2026-11-05T01:30:00.000Z',
    recipe: { config: { api_key: 'learning-secret-value' } },
  });
  await facts.write('experiments', 'other-run', {
    id: 'other-run',
    status: 'succeeded',
  });
  const prefix = 'bindings/proposer/resources/guidance';
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
      experimentId: 'learning-run',
      binding: 'proposer',
      pluginRef: 'proposer.agent',
      policyScopeId: 'root',
      rootRef: 'revision-initial',
      parentRef: ref === 'revision-initial' ? null : 'revision-initial',
      kind: ref === 'revision-initial' ? 'initial' : 'generated',
      status: 'validated',
      resourceRef: resourceRef!,
      sourceResources: [
        {
          pointer: '/guidance',
          kind: 'directory',
          path: guidance,
          artifactPath: prefix,
        },
      ],
      reason:
        ref === 'revision-initial'
          ? null
          : 'Verify saved formula results before delivery. learning-secret-value',
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
  await facts.write('calls', 'memory-update', {
    experimentId: 'learning-run',
    callId: 'memory-update',
    bindingId: 'memoryUpdater',
    pluginId: 'memory.agent',
    status: 'succeeded',
    path: 'search/1/remember',
    startedAt: '2026-11-05T01:15:00.000Z',
    finishedAt: '2026-11-05T01:16:00.000Z',
    input: { memoryRef: memoryBefore },
    output: {
      status: 'updated',
      memoryRef: memoryAfter,
      reason: 'Retain checks from the selected output.',
      changeRef: null,
    },
  });
  return {
    directory,
    guidance,
    facts,
    artifacts,
    application,
    before,
    after,
    memoryBefore,
    memoryAfter,
  };
}
