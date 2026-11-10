import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ApplicationInput,
  ApplicationOutput,
  JsonObject,
  Operation,
  OperationDefinition,
} from '../../contracts/index.js';
import {
  createFileApplication,
  readInstance,
} from '../shared/file-application/files.js';
import { string } from '../../shared/json.js';
import {
  kernelSourceLayout,
  kernelBundleDigest,
  parseKernelExecution,
  type KernelApplicationConfig,
} from './schema.js';

export const createApplicationKernel: OperationDefinition<
  ApplicationInput,
  ApplicationOutput,
  KernelApplicationConfig
>['create'] = async (
  config,
  services,
): Promise<Operation<ApplicationInput, ApplicationOutput>> => {
  return createFileApplication(config, services, (target) => {
    const layout = kernelSourceLayout(config, target);
    const sourcePath = layout.entryFile;
    const paths = [sourcePath, ...layout.additionalFiles].sort();
    return {
      capability: 'kernel-source',
      metadata: layout,
      validateChanges(changes): void {
        for (const change of changes)
          if (change.change !== 'modify' || !paths.includes(change.path))
            throw new Error(
              `Kernel source inventory is fixed: ${change.change} ${change.path}`,
            );
      },
      async verify(directory, context): Promise<JsonObject> {
        context.signal.throwIfAborted();
        const root = await realpath(directory);
        const sourceFiles = [];
        for (const path of paths) {
          const file = join(root, path);
          if (!(await lstat(file)).isFile() || (await realpath(file)) !== file)
            throw new Error(
              `${path} must be a regular source file without symbolic links`,
            );
          const bytes = await readFile(file);
          new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          sourceFiles.push({
            path,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          });
        }
        // Evaluation imports the module and checks the callable entry point.
        context.signal.throwIfAborted();
        return {
          sourceDigest:
            sourceFiles.find((file) => file.path === sourcePath)?.sha256 ?? '',
          sourceFiles,
          sourceBundleDigest: kernelBundleDigest(sourcePath, sourceFiles),
        };
      },
      async acquire(
        directory,
        identity,
        instanceId,
        context,
      ): Promise<JsonObject> {
        context.signal.throwIfAborted();
        const instance = await readInstance(services, instanceId);
        const candidate = await context.readCandidate(
          string(instance?.candidateRef, 'instance.candidateRef'),
        );
        context.signal.throwIfAborted();
        return parseKernelExecution({
          ...identity,
          kind: 'kernel-source',
          format: 'triton-ascend',
          directory,
          sourcePath,
          artifactRef: candidate.artifactRef,
          entryPoint: 'kernel_function',
        });
      },
      async release(): Promise<void> {},
      async dispose(): Promise<void> {},
    };
  });
};
