import type {
  JsonObject,
  JsonSchema,
  RuntimeContext,
} from '../../../contracts/index.js';
import { object, canonical, string } from '../../../shared/json.js';
import { parseConfig, validate } from '../../../shared/schema.js';
import {
  measurementItemsSchema,
  recordSchema,
} from '../../../contracts/models/measurement.js';

type ConstraintCheck = {
  prerequisite: boolean;
  metric: string;
  statistic: string | null;
  definitionRef: string;
  min: number | null;
  max: number | null;
  exclusiveMax?: boolean;
  minRelativeToIncumbent?: number | null;
  maxRelativeToIncumbent?: number | null;
  incumbentValue: number;
  candidateValue: number;
  passed: boolean;
};
type MetricDecision = {
  kind: 'metric-decision';
  measurementRefs: string[];
  itemId: string | null;
  metric: string;
  statistic: string | null;
  direction: 'maximize' | 'minimize';
  definitionRef: string;
  incumbentValue: number;
  candidateValue: number | null;
  minRelativeImprovement: number;
  effectiveMinRelativeImprovement?: number;
  noise?: {
    relativeHalfWidth: number | null;
    samples: number | null;
  };
  constraints: ConstraintCheck[];
  guards?: ConstraintCheck[];
  accepted: boolean;
  tieBreak: 'retain-incumbent';
  reason: string;
};
const ref = { type: 'string', minLength: 1 };
const statistic = { enum: ['mean', 'p50', 'p95', 'p99', null] };
const bound = { type: ['number', 'null'] };
const checks = {
  type: 'array',
  items: recordSchema(
    {
      prerequisite: { type: 'boolean' },
      metric: ref,
      statistic,
      definitionRef: ref,
      min: bound,
      max: bound,
      exclusiveMax: { type: 'boolean' },
      minRelativeToIncumbent: bound,
      maxRelativeToIncumbent: bound,
      incumbentValue: { type: 'number' },
      candidateValue: { type: 'number' },
      passed: { type: 'boolean' },
    },
    [
      'prerequisite',
      'metric',
      'statistic',
      'definitionRef',
      'min',
      'max',
      'incumbentValue',
      'candidateValue',
      'passed',
    ],
  ),
};
export const metricDecisionSchema: JsonSchema = recordSchema(
  {
    kind: { const: 'metric-decision' },
    measurementRefs: { type: 'array', minItems: 2, maxItems: 2, items: ref },
    itemId: { type: ['string', 'null'] },
    metric: ref,
    statistic,
    direction: { enum: ['maximize', 'minimize'] },
    definitionRef: ref,
    incumbentValue: { type: 'number' },
    candidateValue: bound,
    minRelativeImprovement: { type: 'number', minimum: 0, exclusiveMaximum: 1 },
    effectiveMinRelativeImprovement: { type: 'number', minimum: 0 },
    noise: recordSchema(
      {
        relativeHalfWidth: bound,
        samples: { type: ['integer', 'null'] },
      },
      [],
    ),
    constraints: checks,
    guards: checks,
    accepted: { type: 'boolean' },
    tieBreak: { const: 'retain-incumbent' },
    reason: { type: 'string' },
  },
  // Decisions persisted before operator guards and noise were added omit these.
  [
    'kind',
    'measurementRefs',
    'itemId',
    'metric',
    'statistic',
    'direction',
    'definitionRef',
    'incumbentValue',
    'candidateValue',
    'minRelativeImprovement',
    'constraints',
    'accepted',
    'tieBreak',
    'reason',
  ],
);

async function point(
  measurement: JsonObject,
  itemId: string | null,
  context: RuntimeContext,
): Promise<JsonObject> {
  if (itemId === null) return measurement;
  const list = await context.artifacts.readJson(string(measurement.itemsRef));
  validate(measurementItemsSchema, list, 'Measurement items');
  const items = object(list).items;
  if (!Array.isArray(items)) throw new Error('Expected Measurement items');
  const selected = items.map((v) => object(v)).filter((v) => v.id === itemId);
  if (selected.length !== 1 || object(selected[0]!.subject).id !== itemId)
    throw new Error('Decision workload point mismatch');
  return selected[0]!;
}
function metricValue(
  point: JsonObject,
  metric: string,
  statistic: string | null,
  definitionRef: string,
): number {
  const entry = object(
    object(point.metrics)[metric],
    `Decision metric ${metric}`,
  );
  if (entry.status !== 'available' || entry.definitionRef !== definitionRef)
    throw new Error('Decision metric definition mismatch');
  const value = object(entry.value);
  if ((value.kind === 'scalar') !== (statistic === null))
    throw new Error('Decision metric statistic mismatch');
  const number =
    value.kind === 'scalar' ? value.value : value[string(statistic)];
  if (typeof number !== 'number' || !Number.isFinite(number))
    throw new Error('Decision metric value unavailable');
  return number;
}

/** Validate feedback against its real measurement; never accept caller-supplied scores. */
export async function readDecisionFeedback(
  measurementRef: string,
  decisionRef: string,
  candidateRef: string,
  context: RuntimeContext,
): Promise<{
  loss: number;
  constraints: number[];
  identity: JsonObject;
  comparisonKey: string;
}> {
  const decision = parseConfig<MetricDecision>(
    metricDecisionSchema,
    await context.artifacts.readJson(decisionRef),
    'Metric decision',
  );
  if (decision.measurementRefs[1] !== measurementRef)
    throw new Error('Decision candidate measurement mismatch');
  const measurement = await context.readMeasurement(measurementRef);
  if (
    measurement.ref !== measurementRef ||
    measurement.experimentId !== context.experimentId ||
    measurement.candidateRef !== candidateRef
  )
    throw new Error('Decision measurement ownership or candidate mismatch');
  if (measurement.status !== 'succeeded' || measurement.coverage !== 'complete')
    throw new Error('Decision requires a complete successful measurement');
  const selected = await point(measurement, decision.itemId, context);
  if (selected.status !== 'succeeded' || selected.coverage !== 'complete')
    throw new Error('Decision requires a complete successful point');
  if (decision.candidateValue === null)
    throw new Error('Decision feedback requires an available objective');
  if (
    metricValue(
      selected,
      decision.metric,
      decision.statistic,
      decision.definitionRef,
    ) !== decision.candidateValue
  )
    throw new Error('Decision objective does not match measurement');
  const constraints: number[] = [];
  const checks = [...decision.constraints, ...(decision.guards ?? [])];
  for (const check of checks) {
    const minRelative = check.minRelativeToIncumbent ?? null;
    const maxRelative = check.maxRelativeToIncumbent ?? null;
    if (
      check.min === null &&
      check.max === null &&
      minRelative === null &&
      maxRelative === null
    )
      throw new Error('Decision constraint requires a bound');
    if (
      (check.min !== null && check.max !== null && check.min > check.max) ||
      (minRelative !== null &&
        maxRelative !== null &&
        minRelative > maxRelative)
    )
      throw new Error('Decision constraint bounds conflict');
    if (
      metricValue(
        selected,
        check.metric,
        check.statistic,
        check.definitionRef,
      ) !== check.candidateValue
    )
      throw new Error('Decision constraint does not match measurement');
    if (
      (minRelative !== null || maxRelative !== null) &&
      !(check.incumbentValue > 0)
    )
      throw new Error(
        'Decision relative constraint requires a positive incumbent',
      );
    if (check.min !== null) constraints.push(check.min - check.candidateValue);
    if (check.max !== null)
      constraints.push(
        check.exclusiveMax && check.candidateValue === check.max
          ? Number.EPSILON
          : check.candidateValue - check.max,
      );
    if (minRelative !== null)
      constraints.push(
        check.incumbentValue * minRelative - check.candidateValue,
      );
    if (maxRelative !== null)
      constraints.push(
        check.candidateValue - check.incumbentValue * maxRelative,
      );
  }
  return {
    loss:
      decision.direction === 'maximize'
        ? -decision.candidateValue
        : decision.candidateValue,
    constraints,
    comparisonKey: canonical({
      run: string(measurement.comparisonKey),
      point: string(selected.comparisonKey),
    }),
    identity: {
      metric: decision.metric,
      statistic: decision.statistic,
      direction: decision.direction,
      itemId: decision.itemId,
      definitionRef: decision.definitionRef,
      constraints: decision.constraints.map((c) => ({
        prerequisite: c.prerequisite,
        metric: c.metric,
        statistic: c.statistic,
        definitionRef: c.definitionRef,
        min: c.min,
        max: c.max,
        ...(c.exclusiveMax ? { exclusiveMax: true } : {}),
        ...(c.minRelativeToIncumbent !== undefined &&
        c.minRelativeToIncumbent !== null
          ? { minRelativeToIncumbent: c.minRelativeToIncumbent }
          : {}),
        ...(c.maxRelativeToIncumbent !== undefined &&
        c.maxRelativeToIncumbent !== null
          ? { maxRelativeToIncumbent: c.maxRelativeToIncumbent }
          : {}),
      })),
    },
  };
}
