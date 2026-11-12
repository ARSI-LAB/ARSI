import type { JsonObject } from '../../contracts/index.js';
import {
  gymActivationSchema,
  type GymActivation,
} from '../shared/gym/schema.js';

export type GymReleaseMetric = 'successRate' | 'meanReward';

export type GymReleaseConfig = {
  baseUrl: string;
  promotionDefaults: {
    adapter: string;
    benchmark: string;
    seed: number;
    datasetVersion?: string;
    budget?: { maxRollouts?: number; timeoutS?: number };
  };
  poll?: { intervalMs?: number; timeoutMs?: number };
  minDelta?: number;
  metric?: GymReleaseMetric;
  activation?: GymActivation;
};

const text = { type: 'string', minLength: 1 };

export const releaseConfigSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    baseUrl: {
      ...text,
      description: 'eval_service base URL, for example http://127.0.0.1:8411',
    },
    promotionDefaults: {
      type: 'object',
      additionalProperties: false,
      properties: {
        adapter: text,
        benchmark: text,
        seed: { type: 'integer' },
        datasetVersion: text,
        budget: {
          type: 'object',
          additionalProperties: false,
          properties: {
            maxRollouts: { type: 'integer', minimum: 1 },
            timeoutS: { type: 'integer', minimum: 1 },
          },
        },
      },
      required: ['adapter', 'benchmark', 'seed'],
    },
    poll: {
      type: 'object',
      additionalProperties: false,
      properties: {
        intervalMs: { type: 'integer', minimum: 100 },
        timeoutMs: { type: 'integer', minimum: 1000 },
      },
    },
    minDelta: { type: 'number', minimum: 0, default: 0 },
    metric: {
      enum: ['successRate', 'meanReward'],
      default: 'successRate',
      description:
        'Effective holdout objective; successRate uses pass_rate and meanReward uses reward_mean.',
    },
    activation: gymActivationSchema,
  },
  required: ['baseUrl', 'promotionDefaults'],
};
