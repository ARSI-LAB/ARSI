import type {
  ApplicationInput,
  ApplicationOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { configSchema, type AgentbundleConfig } from './schema.js';
import { applicationContract } from '../../contracts/plugin-types/index.js';
import { createApplicationAgentbundle } from './service.js';
import { checkFileApplication } from '../../runtime/doctor/application-checks.js';
export const agentbundleDefinition: OperationDefinition<
  ApplicationInput,
  ApplicationOutput,
  AgentbundleConfig
> = {
  id: 'application.agentbundle',
  description:
    'Manage file-based agent bundles and isolated execution instances.',
  contract: applicationContract,
  configSchema,
  create: createApplicationAgentbundle,
  doctor: checkFileApplication,
};
