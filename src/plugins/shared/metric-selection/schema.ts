import type { JsonSchema, JsonObject } from '../../../contracts/index.js';
import { object } from '../../../shared/json.js';
import { operationSchema, refSchema } from '../agent-editing/index.js';

export type MetricStatistic = 'mean' | 'p50' | 'p95' | 'p99';
export type MetricConstraint = {
  metric: string;
  prerequisite?: boolean;
  statistic?: MetricStatistic;
} & ({ min: number; max?: number } | { min?: number; max: number });
export type MetricSelectorConfig = {
  metric?: string;
  direction?: 'maximize' | 'minimize';
  itemId?: string;
  statistic?: MetricStatistic;
  constraints?: MetricConstraint[];
  minRelativeImprovement?: number;
  tieBreak?: 'retain-incumbent';
};
export type ResolvedMetricSelectorConfig = MetricSelectorConfig &
  Required<
    Pick<
      MetricSelectorConfig,
      | 'metric'
      | 'direction'
      | 'constraints'
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
      },
      ['metric'],
    ),
  ),
  anyOf: [{ required: ['min'] }, { required: ['max'] }],
};
export const configSchema: JsonSchema = operationSchema(
  {
    metric: { type: 'string', minLength: 1, default: 'successRate' },
    direction: { enum: ['maximize', 'minimize'], default: 'maximize' },
    itemId: refSchema,
    statistic: statisticSchema,
    constraints: { type: 'array', items: constraintSchema, default: [] },
    minRelativeImprovement: {
      type: 'number',
      minimum: 0,
      exclusiveMaximum: 1,
      default: 0,
    },
    tieBreak: { const: 'retain-incumbent', default: 'retain-incumbent' },
  },
  [],
);
