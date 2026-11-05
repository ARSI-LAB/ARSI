import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type {
  ApplicationInput,
  ApplicationOutput,
  RuntimeContext,
  JsonObject,
  Operation,
} from '../../../contracts/index.js';
import { object, string } from '../../../shared/json.js';
import { checkTarget, parseTarget, scanTree, type Target } from './target.js';

const ref = { type: 'string', minLength: 1 };
export type FileApplicationConfig = {
  target: { schema: string | JsonObject };
  baseline: { directory: string } | { artifactRef: string };
};
export const fileConfigProperties: JsonObject = {
  target: {
    type: 'object',
    properties: {
      schema: { type: ['string', 'object'], 'x-rsi-path': 'file' },
    },
    required: ['schema'],
    additionalProperties: false,
  },
  baseline: {
    type: 'object',
    properties: {
      directory: { ...ref, 'x-rsi-path': 'directory' },
      artifactRef: ref,
    },
    oneOf: [
      { required: ['directory'], not: { required: ['artifactRef'] } },
      { required: ['artifactRef'], not: { required: ['directory'] } },
    ],
    additionalProperties: false,
  },
};
export interface ApplicationBackend {
  capability: string;
  verify(directory: string, context: RuntimeContext): Promise<JsonObject>;
  acquire(
    directory: string,
    identity: JsonObject,
    instanceId: string,
    context: RuntimeContext,
  ): Promise<JsonObject>;
  release(instance: JsonObject, context: RuntimeContext): Promise<void>;
  dispose(): Promise<void>;
}
export async function readInstance(
  services: RuntimeContext,
  id: string,
): Promise<JsonObject | null> {
  try {
    return await services.facts.read('instances', id);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return null;
    throw error;
  }
}
async function readTarget(
  config: FileApplicationConfig,
  root: string,
): Promise<{ raw: JsonObject; target: Target }> {
  const setting = config.target.schema;
  let raw: JsonObject;
  if (typeof setting === 'string') {
    const doc = parseDocument(await readFile(resolve(root, setting), 'utf8'), {
      uniqueKeys: true,
    });
    if (doc.errors.length)
      throw new Error(doc.errors.map((e) => e.message).join('; '));
    raw = object(doc.toJS({ maxAliasCount: 0 }), 'target');
  } else raw = object(setting, 'target.schema');
  return { raw, target: parseTarget(raw) };
}
export async function createFileApplication(
  config: FileApplicationConfig,
  services: RuntimeContext,
  backend: ApplicationBackend,
): Promise<Operation<ApplicationInput, ApplicationOutput>> {
  const { raw, target } = await readTarget(config, services.rootDirectory);
  const baseline = config.baseline;
  const active = new Map<string, RuntimeContext>();
  async function releaseInstance(
    instanceId: string,
    context: RuntimeContext,
  ): Promise<Extract<ApplicationOutput, { action: 'release' }>> {
    const instance = await readInstance(services, instanceId);
    if (!instance || instance.experimentId !== context.experimentId)
      throw new Error(`unknown application instance: ${instanceId}`);
    if (instance.status === 'released')
      return { action: 'release', instanceId, status: 'released' };
    await backend.release(instance, context);
    if (typeof instance.workspaceRef === 'string')
      await services.workspaces.release(instance.workspaceRef);
    await services.facts.write('instances', instanceId, {
      ...instance,
      status: 'released',
    });
    active.delete(instanceId);
    return { action: 'release', instanceId, status: 'released' };
  }
  return {
    async execute(input, context): Promise<ApplicationOutput> {
      object(input, 'application input');
      context.signal.throwIfAborted();
      const action = input.action;
      switch (input.action) {
        case 'initialize': {
          const artifactRef =
            'artifactRef' in baseline
              ? baseline.artifactRef
              : await services.artifacts.capture(
                  resolve(
                    services.rootDirectory,
                    string(baseline.directory, 'baseline.directory'),
                  ),
                );
          const workspace = await services.workspaces.create(artifactRef);
          try {
            const tree = await scanTree(workspace.directory);
            for (const entry of target.entries)
              if (entry.kind === 'file' && !tree[entry.path])
                throw new Error(
                  `Target file is missing from baseline: ${entry.path}`,
                );
            await backend.verify(workspace.directory, context);
            const initialCandidateRef = await context.recordCandidate(
              artifactRef,
              null,
            );
            return {
              action: 'initialize',
              initialCandidateRef,
              target: raw,
              capabilities: [backend.capability],
            };
          } finally {
            await services.workspaces.release(workspace.ref);
          }
        }
        case 'commit': {
          const parentCandidateRef = string(input.parentCandidateRef);
          const parent = await context.readCandidate(parentCandidateRef);
          const edit = await services.workspaces.read(string(input.editRef));
          if (edit.parentCandidateRef !== parentCandidateRef)
            throw new Error('editRef parent candidate identity mismatch');
          const artifactRef = await services.artifacts.capture(edit.directory);
          const parentSpace = await services.workspaces.create(
            parent.artifactRef,
          );
          let snapshot: Awaited<
            ReturnType<typeof services.workspaces.create>
          > | null = null;
          try {
            snapshot = await services.workspaces.create(artifactRef);
            const [before, after] = await Promise.all([
              scanTree(parentSpace.directory),
              scanTree(snapshot.directory),
            ]);
            const changes = checkTarget(
              before,
              after,
              target,
              input.editConstraints === undefined
                ? {}
                : object(input.editConstraints),
            );
            if (!changes.length)
              return {
                action: 'commit',
                status: 'no-change',
                candidateRef: parentCandidateRef,
                diffRef: null,
              };
            await backend.verify(snapshot.directory, context);
            const candidateRef = await context.recordCandidate(
              artifactRef,
              parentCandidateRef,
            );
            const diffRef = await services.artifacts.putJson({
              parentCandidateRef,
              candidateRef,
              changes,
            });
            return {
              action: 'commit',
              status: 'created',
              candidateRef,
              diffRef,
            };
          } finally {
            await Promise.allSettled([
              services.workspaces.release(parentSpace.ref),
              ...(snapshot ? [services.workspaces.release(snapshot.ref)] : []),
            ]);
          }
        }
        case 'acquire': {
          const instanceId = string(input.instanceId);
          if (input.capability !== backend.capability)
            throw new Error(
              `Application does not support ${String(input.capability)}`,
            );
          const candidateRef = string(input.candidateRef);
          const candidate = await context.readCandidate(candidateRef);
          const existing = await readInstance(services, instanceId);
          if (existing) {
            if (
              existing.experimentId !== context.experimentId ||
              existing.candidateRef !== candidateRef
            )
              throw new Error('instance identity conflict');
            if (existing.status === 'ready') {
              await services.workspaces.read(string(existing.workspaceRef));
              return {
                action: 'acquire',
                instanceId,
                execution: object(existing.execution),
              };
            }
            throw new Error(
              `instance requires reconciliation: ${String(existing.status)}`,
            );
          }
          const intent: JsonObject = {
            instanceId,
            candidateRef,
            experimentId: context.experimentId,
            callId: context.callId,
            status: 'preparing',
            workspaceRef: null,
          };
          await services.facts.write('instances', instanceId, intent);
          active.set(instanceId, context);
          const workspace = await services.workspaces.create(
            candidate.artifactRef,
          );
          let instance: JsonObject = {
            ...intent,
            workspaceRef: workspace.ref,
            directory: workspace.directory,
          };
          await services.facts.write('instances', instanceId, instance);
          try {
            const identity = await backend.verify(workspace.directory, context);
            const execution = {
              ...(await backend.acquire(
                workspace.directory,
                identity,
                instanceId,
                context,
              )),
              workspaceRef: workspace.ref,
              directory: workspace.directory,
              artifactDigest: candidate.artifactRef,
            };
            instance = {
              ...((await readInstance(services, instanceId)) ?? instance),
              status: 'ready',
              execution,
            };
            await services.facts.write('instances', instanceId, instance);
            return { action: 'acquire', instanceId, execution };
          } catch (error) {
            try {
              await releaseInstance(
                instanceId,
                context.extend({ signal: context.cleanup }),
              );
            } catch (cleanupError) {
              await services.facts.write('instances', instanceId, {
                ...instance,
                status: 'unknown',
                cleanupError:
                  cleanupError instanceof Error
                    ? cleanupError.message
                    : String(cleanupError),
              });
            }
            throw error;
          }
        }
        case 'release':
          return releaseInstance(string(input.instanceId), context);
        default:
          throw new Error(`Unsupported application action ${String(action)}`);
      }
    },
    async dispose(): Promise<void> {
      const results = await Promise.allSettled(
        [...active].map(([instanceId, context]) =>
          releaseInstance(
            instanceId,
            context.extend({ signal: context.cleanup }),
          ),
        ),
      );
      await backend.dispose();
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  };
}
