import { persistFact } from '../storage/persistence-error.js';
import {
  parseFileTree,
  type ArtifactStore,
  type FactStore,
  type FileTreeFile,
  type JsonObject,
} from '../../contracts/index.js';
import { canonical, digest, object, string } from '../../shared/json.js';
import { inspectPath, stat, validateSnapshotEntry } from './snapshot-paths.js';
import { excludedArtifactEntries } from '../storage/index.js';
import type { LearningResult } from './records.js';
import { runLearningCycle, type CycleOptions } from './runner.js';
import type { MemoryConfig } from './validation.js';

export interface ActiveMemory extends JsonObject {
  ref: string;
  artifactRef: string;
  rootRef: string;
}
export function parseActiveMemory(value: unknown): ActiveMemory {
  const record = object(value, 'active Memory');
  return {
    ref: string(record.ref),
    artifactRef: string(record.artifactRef),
    rootRef: string(record.rootRef),
  };
}
/** A Memory version contains only ordinary non-executable UTF-8 files. */
export function memoryFiles(raw: unknown): FileTreeFile[] {
  const tree = parseFileTree(raw);
  const paths = new Set(tree.files.map((file) => file.path));
  for (const file of tree.files) {
    validateSnapshotEntry(file.path);
    if (
      file.path
        .split('/')
        .some((part) => excludedArtifactEntries.includes(part))
    )
      throw new Error('Unsupported Memory snapshot entry: ' + file.path);
    if (file.mode & 0o111)
      throw new Error('Executable Memory file: ' + file.path);
    const content = Buffer.from(file.base64, 'base64');
    if (content.includes(0))
      throw new Error('Binary Memory resource: ' + file.path);
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch (cause) {
      throw new Error('Invalid UTF-8 Memory resource: ' + file.path, { cause });
    }
    const parts = file.path.split('/');
    for (let count = 1; count < parts.length; count++)
      if (paths.has(parts.slice(0, count).join('/')))
        throw new Error('Memory file is also a directory: ' + file.path);
  }
  return tree.files;
}
export async function captureMemorySeed(
  artifacts: ArtifactStore,
  directory?: string,
): Promise<string> {
  if (directory) {
    await inspectPath(directory);
    const existing = await stat(directory);
    if (existing) {
      if (!existing.isDirectory())
        throw new Error('Invalid Memory directory: ' + directory);
      return artifacts.capture(directory);
    }
  }
  return artifacts.putJson({ kind: 'file-tree', files: [] });
}
export async function initializeMemory(options: {
  config: MemoryConfig;
  experimentId: string;
  sourceDirectory?: string;
  facts: FactStore;
  artifacts: ArtifactStore;
  save(memory: ActiveMemory): Promise<void>;
}): Promise<void> {
  const { config, experimentId, facts, artifacts } = options;
  const artifactRef = string(
    config.seedArtifactRef,
    'locked initial Memory artifact',
  );
  memoryFiles(await artifacts.readJson(artifactRef));
  const ref =
    'memory-' + digest({ experimentId, artifactRef, seed: 'initial' });
  const memory = { ref, rootRef: ref, artifactRef };
  await persistFact(facts, 'memory-revisions', ref, {
    ...memory,
    resourceRef: artifactRef,
    changeRef: null,
    reason: 'Initial Memory snapshot',
    experimentId,
    parentRef: null,
    parentArtifactRef: null,
    kind: 'initial',
    status: 'initial',
    sourceDirectory: options.sourceDirectory ?? null,
  });
  await options.save(memory);
}
interface MemoryOptions extends CycleOptions {
  config: MemoryConfig;
  active(): ActiveMemory | null;
  saveMemory(memory: ActiveMemory, learningId: string): Promise<void>;
}
export async function remember(
  options: MemoryOptions,
): Promise<LearningResult> {
  const { context, config } = options;
  const includes = async (record: JsonObject): Promise<boolean> => {
    let ref: string | null = options.active()?.ref ?? null;
    const visited = new Set<string>();
    while (ref && !visited.has(ref)) {
      if (ref === record.memoryRef) return true;
      visited.add(ref);
      const parent = (await context.facts.read('memory-revisions', ref))
        .parentRef;
      ref = typeof parent === 'string' ? parent : null;
    }
    return false;
  };
  return runLearningCycle(options, 'memory', {
    includes,
    parentsMatch: (record) =>
      record.parentRef === (options.active()?.ref ?? null),
    async execute(cycle) {
      const { prior, identity } = cycle;
      const parent = options.active();
      if (prior?.status === 'validated') {
        if (!(await includes(prior))) {
          if (prior.parentRef !== (parent?.ref ?? null))
            throw new Error(
              'Memory recovery conflicts with the active snapshot',
            );
          cycle.assertScope();
          await options.saveMemory(parseActiveMemory(prior.memory), identity);
        }
        return cycle.finish('activated', prior);
      }
      const evidence = await cycle.evidence();
      if (!evidence.callCount)
        return cycle.finish('skipped', {
          reason: 'no usable observations in this evidence window',
        });
      const input = {
        goal: config.goal,
        evidenceRefs: [string(evidence.ref)],
        parentVersionRef: parent?.ref ?? null,
        resourceRef: parent?.artifactRef ?? null,
        editConstraints: {},
      };
      if (
        prior?.status === 'prepared' &&
        canonical(input) !== canonical(prior.input)
      )
        throw new Error('Prepared Memory input changed before recovery');
      const parents = {
        parentRef: parent?.ref ?? null,
        parentArtifactRef: parent?.artifactRef ?? null,
      };
      await cycle.save('prepared', { ...parents, input });
      const result = object(await cycle.invoke(input));
      const reason = result.reason;
      if (typeof reason !== 'string')
        throw new Error('Memory proposal reason must be a string');
      if (result.status === 'no-change')
        return cycle.finish('no-change', { reason, ...parents });
      if (result.status !== 'updated')
        throw new Error('Invalid Memory proposal');
      const artifactRef = string(result.resourceRef),
        changeRef = string(result.changeRef);
      await context.artifacts.readJson(changeRef);
      const before = parent
        ? memoryFiles(await context.artifacts.readJson(parent.artifactRef))
        : [];
      const after = memoryFiles(await context.artifacts.readJson(artifactRef));
      const previous = new Map(before.map((file) => [file.path, file]));
      if (
        after.some(
          (file) =>
            previous.has(file.path) &&
            previous.get(file.path)!.mode !== file.mode,
        )
      )
        throw new Error('Memory resource mode change denied');
      if (
        before.length === after.length &&
        after.every((file) => previous.get(file.path)?.base64 === file.base64)
      )
        return cycle.finish('no-change', { reason, ...parents });
      const ref =
        'memory-' +
        digest({
          experimentId: context.experimentId,
          identity,
          artifactRef,
          ...parents,
        });
      const memory = { ref, artifactRef, rootRef: parent?.rootRef ?? ref };
      const sourceDirectory = parent
        ? (await context.facts.read('memory-revisions', parent.rootRef))
            .sourceDirectory
        : null;
      await persistFact(context.facts, 'memory-revisions', ref, {
        ...memory,
        resourceRef: artifactRef,
        sourceDirectory: sourceDirectory ?? null,
        ...parents,
        experimentId: context.experimentId,
        kind: 'generated',
        status: 'validated',
        learningId: identity,
        changeRef,
        reason,
      });
      const validated = { ...parents, memory, memoryRef: ref, reason };
      await cycle.save('validated', validated);
      cycle.assertScope();
      await options.saveMemory(memory, identity);
      return cycle.finish('activated', validated);
    },
  });
}
