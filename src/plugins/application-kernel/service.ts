import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ApplicationInput,
  ApplicationOutput,
  JsonObject,
  Operation,
  OperationDefinition,
  RuntimeContext,
} from '../../contracts/index.js';
import {
  createFileApplication,
  readInstance,
  type ApplicationBackend,
} from '../shared/file-application/files.js';
import {
  createScriptedApplicationWithBackend,
  createScriptedLifecycleBackend,
  type ScriptedBackend,
  type ScriptedLifecycleOptions,
} from '../shared/scripted-lifecycle/index.js';
import { object, string } from '../../shared/json.js';
import type { KernelApplicationConfig } from './schema.js';

const lifecycleOptions: ScriptedLifecycleOptions = {
  namespace: 'application-kernel',
  // The evaluator acquires instances by this capability.
  capability: 'kernel-source',
  subject: 'Kernel',
  lifecycleLabel: 'Kernel lifecycle',
  capacityLabel: 'Kernel build',
  resourcesLabel: 'kernel resources',
  lockDirectory: 'application-kernel/local-locks',
  defaultParametersFile: 'config.json',
  parametersLabel: 'kernel config parameters',
  parameterLabel: 'kernel config parameter',
  configSection: 'lifecycle',
};

async function verifyKernelSource(
  directory: string,
  context: RuntimeContext,
): Promise<JsonObject> {
  context.signal.throwIfAborted();
  const path = join(directory, 'input.py');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('input.py must be a regular source file');
  const bytes = await readFile(path);
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // This is a structural entry check. Syntax and device compilation belong
  // to evaluation, so defective candidates can still receive feedback.
  if (!/^def[\t ]+kernel_function[\t ]*\(/m.test(source))
    throw new Error('input.py must declare the kernel_function entry point');
  context.signal.throwIfAborted();
  return { sourceDigest: createHash('sha256').update(bytes).digest('hex') };
}

function kernelExecutionBackend(
  acquire: ApplicationBackend['acquire'],
): ApplicationBackend {
  return {
    capability: 'kernel-source',
    verify: verifyKernelSource,
    acquire,
    async release(): Promise<void> {},
    async dispose(): Promise<void> {},
  };
}

export const createApplicationKernel: OperationDefinition<
  ApplicationInput,
  ApplicationOutput,
  KernelApplicationConfig
>['create'] = async (
  config,
  services,
): Promise<Operation<ApplicationInput, ApplicationOutput>> => {
  if (config.lifecycle === undefined)
    return createFileApplication(
      config,
      services,
      kernelExecutionBackend(
        async (directory, identity, instanceId, context) => {
          context.signal.throwIfAborted();
          const instance = await readInstance(services, instanceId);
          const candidate = await context.readCandidate(
            string(instance?.candidateRef, 'instance.candidateRef'),
          );
          context.signal.throwIfAborted();
          return {
            ...identity,
            kind: 'kernel-source',
            format: 'triton-ascend',
            directory,
            artifactRef: candidate.artifactRef,
            entryPoint: 'kernel_function',
          };
        },
      ),
    );
  // Scripted lifecycle mode: the script owns sync, build, and the correctness
  // precheck. The lifecycle identity (verified device/software resources) is
  // folded into a KernelExecution so the evaluator can consume the instance
  // unchanged. A precheck rejection resolves as an unverified execution
  // (resources.verified false + rejection detail) instead of throwing: a
  // failed acquire call aborts the whole experiment, while the rejection is a
  // per-candidate outcome the evaluator records as an auditable failed
  // measurement.
  const scripted = createScriptedLifecycleBackend(
    lifecycleOptions,
    config.lifecycle,
    config.healthcheck ?? {},
    config.shutdown ?? {},
    services,
  );
  const backend: ScriptedBackend = {
    ...scripted,
    capability: 'kernel-source',
    async verify(directory, context): Promise<JsonObject> {
      const parameters = await scripted.verify(directory, context);
      const source = await verifyKernelSource(directory, context);
      return { ...parameters, ...source };
    },
    async acquire(
      directory,
      identity,
      instanceId,
      context,
    ): Promise<JsonObject> {
      const raw = await scripted.acquire(
        directory,
        identity,
        instanceId,
        context,
      );
      const resources = object(raw.resources, 'kernel resources');
      const instance = await readInstance(services, instanceId);
      const candidate = await context.readCandidate(
        string(instance?.candidateRef, 'instance.candidateRef'),
      );
      context.signal.throwIfAborted();
      const execution: JsonObject = {
        kind: 'kernel-source',
        format: 'triton-ascend',
        directory,
        artifactRef: candidate.artifactRef,
        sourceDigest: string(identity.sourceDigest, 'identity.sourceDigest'),
        entryPoint: 'kernel_function',
      };
      if (resources.verified === false)
        return {
          ...execution,
          resources: { verified: false },
          rejection: raw.rejection ?? null,
        };
      return execution;
    },
  };
  return createScriptedApplicationWithBackend(
    config as JsonObject,
    backend,
    services,
  );
};
