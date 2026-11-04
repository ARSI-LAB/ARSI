import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
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
import type { KernelApplicationConfig } from './schema.js';

export const createApplicationKernel: OperationDefinition<
  ApplicationInput,
  ApplicationOutput,
  KernelApplicationConfig
>['create'] = async (
  config,
  services,
): Promise<Operation<ApplicationInput, ApplicationOutput>> => {
  return createFileApplication(config, services, {
    capability: 'kernel-source',
    async verify(directory, context): Promise<JsonObject> {
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
        throw new Error(
          'input.py must declare the kernel_function entry point',
        );
      context.signal.throwIfAborted();
      return { sourceDigest: createHash('sha256').update(bytes).digest('hex') };
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
      return {
        ...identity,
        kind: 'kernel-source',
        format: 'triton-ascend',
        directory,
        artifactRef: candidate.artifactRef,
        entryPoint: 'kernel_function',
      };
    },
    async release(): Promise<void> {},
    async dispose(): Promise<void> {},
  });
};
