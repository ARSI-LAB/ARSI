import { createHash } from 'node:crypto';
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
import { scanTree } from '../shared/file-application/target.js';
import {
  kernelSourcePath,
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
    const sourcePath = kernelSourcePath(target, config.entryFile);
    return {
      capability: 'kernel-source',
      validateChanges(changes): void {
        for (const change of changes)
          if (change.change !== 'modify')
            throw new Error(
              `Kernel source inventory is fixed: ${change.change} ${change.path}`,
            );
      },
      async verify(directory, context): Promise<JsonObject> {
        context.signal.throwIfAborted();
        const tree = await scanTree(directory);
        if (!tree[sourcePath])
          throw new Error(`Kernel entry file is missing: ${sourcePath}`);
        const sourceFiles = Object.entries(tree).map(([path, file]) => {
          const bytes = Buffer.from(file.content, 'base64');
          new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          return {
            path,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          };
        });
        // Evaluation imports the module and checks the callable entry point.
        context.signal.throwIfAborted();
        return {
          sourceDigest: string(
            sourceFiles.find((file) => file.path === sourcePath)?.sha256,
          ),
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
