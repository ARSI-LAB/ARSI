import type { OperationDefinition } from '../../contracts/index.js';
import {
  gridProposerContract,
  type GridProposerInput,
  type GridProposerOutput,
} from '../../contracts/plugin-types/proposer-grid.js';
import { configSchema, type GridProposerConfig } from './schema.js';
import { createGridProposer } from './service.js';

export const gridProposerDefinition: OperationDefinition<
  GridProposerInput,
  GridProposerOutput,
  GridProposerConfig
> = {
  id: 'proposer.grid',
  description: 'Propose parameter candidates from a deterministic grid.',
  contract: gridProposerContract,
  configSchema,
  create: createGridProposer,
};
