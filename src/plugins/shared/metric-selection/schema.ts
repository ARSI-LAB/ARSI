import type { JsonSchema, JsonObject } from '../../../contracts/index.js';
import { object } from '../../../shared/json.js';
import { operationSchema, refSchema } from '../agent-editing/index.js';

export type MetricStatistic = 'mean' | 'p50' | 'p95' | 'p99';
type MetricBound =
  | { min: number }
  | { max: number }
  | { minRelativeToIncumbent: number }
  | { maxRelativeToIncumbent: number };
export type MetricConstraint = {
  metric: string;
  prerequisite?: boolean;
  statistic?: MetricStatistic;
  exclusiveMax?: boolean;
  min?: number;
  max?: number;
  minRelativeToIncumbent?: number;
  maxRelativeToIncumbent?: number;
} & MetricBound;
export type MetricNoise = {
  minSamples?: number;
  statistic?: MetricStatistic;
  confidenceZ?: number;
  minRelativeImprovementFloor?: number;
};
export type MetricSelectorConfig = {
  metric?: string;
  direction?: 'maximize' | 'minimize';
  itemId?: string;
  statistic?: MetricStatistic;
  constraints?: MetricConstraint[];
  guards?: MetricConstraint[];
  minRelativeImprovement?: number;
  noise?: MetricNoise;
  tieBreak?: 'retain-incumbent';
};
export type ResolvedMetricSelectorConfig = MetricSelectorConfig &
  Required<
    Pick<
      MetricSelectorConfig,
      | 'metric'
      | 'direction'
      | 'constraints'
      | 'guards'
      | 'minRelativeImprovement'
      | 'tieBreak'
    >
  >;

const statisticSchema: JsonObject = { enum: ['mean', 'p50', 'p95', 'p99'] };
const constraintSchema: JsonObject = {
  ...object(
    operationSchema(
      {
        metric: refSchema,
        prerequisite: { type: 'boolean' },
        statistic: statisticSchema,
        min: { type: 'number' },
        max: { type: 'number' },
        minRelativeToIncumbent: { type: 'number', exclusiveMinimum: 0 },
        maxRelativeToIncumbent: { type: 'number', exclusiveMinimum: 0 },
        exclusiveMax: { type: 'boolean' },
      },
      ['metric'],
    ),
  ),
  anyOf: [
    { required: ['min'] },
    { required: ['max'] },
    { required: ['minRelativeToIncumbent'] },
    { required: ['maxRelativeToIncumbent'] },
  ],
};
const noiseSchema: JsonObject = operationSchema(
  {
    minSamples: { type: 'integer', minimum: 2, default: 3 },
    statistic: statisticSchema,
    confidenceZ: { type: 'number', exclusiveMinimum: 0, default: 1.96 },
    minRelativeImprovementFloor: {
      type: 'number',
      minimum: 0,
      exclusiveMaximum: 1,
      default: 0,
    },
  },
  [],
);
export const configSchema: JsonSchema = operationSchema(
  {
    metric: { type: 'string', minLength: 1, default: 'successRate' },
    direction: { enum: ['maximize', 'minimize'], default: 'maximize' },
    itemId: refSchema,
    statistic: statisticSchema,
    constraints: { type: 'array', items: constraintSchema, default: [] },
    guards: { type: 'array', items: constraintSchema, default: [] },
    minRelativeImprovement: {
      type: 'number',
      minimum: 0,
      exclusiveMaximum: 1,
      default: 0,
    },
    noise: noiseSchema,
    tieBreak: { const: 'retain-incumbent', default: 'retain-incumbent' },
  },
  [],
);
