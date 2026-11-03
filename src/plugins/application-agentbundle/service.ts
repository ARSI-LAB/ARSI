import { createBundleSdk } from 'agent-bundle-core';
import type {
  ApplicationInput,
  ApplicationOutput,
  JsonObject,
  Operation,
  OperationDefinition,
} from '../../contracts/index.js';
import { createFileApplication } from '../shared/file-application/files.js';
import { validateSkills } from './skills.js';
import type { AgentbundleConfig } from './schema.js';

export const createApplicationAgentbundle: OperationDefinition<
  ApplicationInput,
  ApplicationOutput,
  AgentbundleConfig
>['create'] = async (
  config,
  services,
): Promise<Operation<ApplicationInput, ApplicationOutput>> => {
  return createFileApplication(config, services, {
    capability: 'agentbundle',
    async verify(directory, context): Promise<JsonObject> {
      context.signal.throwIfAborted();
      await validateSkills(directory);
      const verified = await createBundleSdk().verify(directory);
      context.signal.throwIfAborted();
      return {
        bundleDigest: verified.digest,
        bundleKind: verified.manifest.kind,
        harnessVersionRange: verified.manifest.harnessVersion,
      };
    },
    async acquire(_directory, identity): Promise<JsonObject> {
      return { kind: 'agentbundle', ...identity };
    },
    async release(): Promise<void> {},
    async dispose(): Promise<void> {},
  });
};
