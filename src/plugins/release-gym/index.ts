import type {
  OperationDefinition,
  ReleaseInput,
  ReleaseOutput,
} from '../../contracts/index.js';
import { releaseContract } from '../../contracts/plugin-types/index.js';
import { releaseConfigSchema, type GymReleaseConfig } from './schema.js';
import { createGymRelease } from './service.js';

export const gymReleaseDefinition: OperationDefinition<
  ReleaseInput,
  ReleaseOutput,
  GymReleaseConfig
> = {
  id: 'release.gym',
  description:
    'Gate a frozen candidate against the incumbent through Gym holdout promotion.',
  contract: releaseContract,
  configSchema: releaseConfigSchema,
  create: (config, context) =>
    createGymRelease(config, context, releaseConfigSchema),
};
