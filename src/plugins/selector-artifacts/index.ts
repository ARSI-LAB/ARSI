import type {
  ArtifactSelectorInput,
  ArtifactSelectorOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import { configSchema, type AgentEditingConfig } from './schema.js';
import { artifactSelectorContract } from '../../contracts/plugin-types/index.js';
import { createArtifactSelector } from './service.js';
import { checkAgentEditor } from '../../runtime/doctor/business-checks.js';
export const artifactSelectorDefinition: OperationDefinition<
  ArtifactSelectorInput,
  ArtifactSelectorOutput,
  AgentEditingConfig
> = {
  id: 'selector.artifact',
  description: 'Select candidates by anonymous artifact review.',
  contract: artifactSelectorContract,
  configSchema,
  create: createArtifactSelector,
  doctor: checkAgentEditor,
};
