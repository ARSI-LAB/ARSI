import type {
  OperationDefinition,
  ProposerInput,
  ProposerOutput,
} from '../../contracts/index.js';
import { configSchema, type AgentEditingConfig } from './schema.js';
import { proposerContract } from '../../contracts/plugin-types/index.js';
import { createProposerAgent } from './service.js';
import { checkAgentEditor } from '../../runtime/doctor/business-checks.js';
export const proposerDefinition: OperationDefinition<
  ProposerInput,
  ProposerOutput,
  AgentEditingConfig
> = {
  id: 'proposer.agent',
  description: 'Propose candidate edits using an agent.',
  contract: proposerContract,
  configSchema,
  create: createProposerAgent,
  doctor: checkAgentEditor,
};
