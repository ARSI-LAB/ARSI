import type { JsonSchema, JsonObject } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import { operationSchema, refSchema } from '../shared/agent-editing/index.js';

export type MetricStatistic = 'mean' | 'p50' | 'p95' | 'p99';
export type MetricConstraint = {
  metric: string;
  statistic?: MetricStatistic;
} & ({ min: number; max?: number } | { min?: number; max: number });
export type MetricSelectorConfig = {
  metric?: string;
  direction?: 'maximize' | 'minimize';
  itemId?: string;
  statistic?: MetricStatistic;
  constraints?: MetricConstraint[];
  tieBreak?: 'retain-incumbent';
};
export type ResolvedMetricSelectorConfig = MetricSelectorConfig &
  Required<
    Pick<
      MetricSelectorConfig,
      'metric' | 'direction' | 'constraints' | 'tieBreak'
    >
  >;

const statisticSchema: JsonObject = { enum: ['mean', 'p50', 'p95', 'p99'] };
const constraintSchema: JsonObject = {
  ...object(
    operationSchema(
      {
        metric: refSchema,
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
    tieBreak: { const: 'retain-incumbent', default: 'retain-incumbent' },
  },
  [],
);
