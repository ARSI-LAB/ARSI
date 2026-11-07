import type { JsonObject } from '../../contracts/index.js';

export type GepaModule = {
  /** Stable module identity used for rotation and merge bookkeeping. */
  id: string;
  /** Bundle-relative path edited by a mutation or merge. */
  path: string;
};

export type GepaSettings = {
  feedbackTaskIds: string[];
  selectionTaskIds: string[];
  maxRounds: number;
  maxRollouts: number;
  minibatchSize: number;
  paretoSize: number;
  seed: number;
  crossoverEvery: number;
  modules: GepaModule[];
  goal: string;
  editConstraints?: JsonObject;
};

export type GepaConfig = Omit<
  GepaSettings,
  'feedbackTaskIds' | 'selectionTaskIds'
>;

export const stringArray = (minItems: number): JsonObject => ({
  type: 'array',
  minItems,
  uniqueItems: true,
  items: { type: 'string', minLength: 1 },
});

export const configSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'maxRounds',
    'maxRollouts',
    'minibatchSize',
    'paretoSize',
    'seed',
    'crossoverEvery',
    'modules',
    'goal',
  ],
  properties: {
    maxRounds: { type: 'integer', minimum: 0, maximum: 100000 },
    maxRollouts: { type: 'integer', minimum: 0, maximum: 1000000000 },
    minibatchSize: { type: 'integer', minimum: 1, maximum: 100000 },
    paretoSize: { type: 'integer', minimum: 1, maximum: 100000 },
    seed: { type: 'integer', minimum: 0, maximum: 2147483647 },
    crossoverEvery: { type: 'integer', minimum: 0, maximum: 100000 },
    modules: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'path'],
        properties: {
          id: { type: 'string', minLength: 1 },
          path: { type: 'string', minLength: 1 },
        },
      },
    },
    goal: { type: 'string', minLength: 1 },
    editConstraints: { type: 'object' },
  },
};
