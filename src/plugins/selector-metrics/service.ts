import { metricDecisionSchema } from '../shared/metric-decision/index.js';
import type {
  RuntimeContext,
  JsonObject,
  MetricSelectorInput,
  MetricSelectorOutput,
  OperationDefinition,
} from '../../contracts/index.js';
import {
  measurementItemsSchema,
  metricDefinitionSchema,
  validateMeasurement,
} from '../../contracts/models/measurement.js';
import { json, object, string } from '../../shared/json.js';
import { parseConfig, validate } from '../../shared/schema.js';
import {
  configSchema,
  type MetricSelectorConfig,
  type ResolvedMetricSelectorConfig,
} from './schema.js';
import { metricSelectorContract } from '../../contracts/plugin-types/index.js';
function assertComparable(
  before: JsonObject,
  after: JsonObject,
  label: string,
): void {
  if (
    before.status !== 'succeeded' ||
    after.status !== 'succeeded' ||
    before.coverage !== 'complete' ||
    after.coverage !== 'complete' ||
    typeof before.comparisonKey !== 'string' ||
    !before.comparisonKey ||
    before.comparisonKey !== after.comparisonKey
  )
    throw new Error(`${label} are not complete and comparable`);
}
async function scope(
  services: RuntimeContext,
  measurement: JsonObject,
  itemId: string | undefined,
): Promise<JsonObject> {
  if (itemId === undefined) return measurement;
  const list = await services.artifacts.readJson(string(measurement.itemsRef));
  validate(measurementItemsSchema, list, 'Measurement item list');
  const items = object(list).items;
  if (!Array.isArray(items))
    throw new Error('Measurement item list must contain items');
  const matches = items
    .map((value) => object(value))
    .filter((item) => item.id === itemId);
  if (matches.length !== 1)
    throw new Error(`Measurement must contain exactly one item ${itemId}`);
  const item = matches[0]!;
  const subject = object(item.subject);
  if (subject.id !== itemId)
    throw new Error('Measurement point subject does not match its item ID');
  return item;
}
async function comparableValues(
  services: RuntimeContext,
  before: JsonObject,
  after: JsonObject,
  metricId: string,
  statistic: string | undefined,
): Promise<{ before: number; after: number; definitionRef: string }> {
  const first = object(before.metrics),
    second = object(after.metrics);
  if (!Object.hasOwn(first, metricId) || !Object.hasOwn(second, metricId))
    throw new Error(`Metric ${metricId} is unavailable in the selected scope`);
  const a = object(first[metricId]),
    b = object(second[metricId]);
  if (
    a.status !== 'available' ||
    b.status !== 'available' ||
    typeof a.definitionRef !== 'string' ||
    a.definitionRef !== b.definitionRef
  )
    throw new Error(
      `Missing or incompatible metric definition for ${metricId}`,
    );
  const definitionRef = a.definitionRef;
  const definition = await services.artifacts.readJson(definitionRef);
  validate(metricDefinitionSchema, definition, 'Metric definition');
  const spec = object(definition);
  if (spec.id !== metricId)
    throw new Error('Metric definition ID does not match the selected metric');
  const number = (metric: JsonObject): number => {
    const value = object(metric.value);
    if (value.kind !== spec.valueKind)
      throw new Error('Metric value kind does not match its definition');
    if (value.kind === 'scalar' && statistic !== undefined)
      throw new Error('Scalar metric does not accept a distribution statistic');
    if (value.kind === 'distribution' && statistic === undefined)
      throw new Error('Distribution metric requires an explicit statistic');
    const n = value.kind === 'scalar' ? value.value : value[string(statistic)];
    if (typeof n !== 'number' || !Number.isFinite(n))
      throw new Error(`Metric ${metricId} value unavailable`);
    return n;
  };
  return { before: number(a), after: number(b), definitionRef };
}
export const createMetricSelector: OperationDefinition<
  MetricSelectorInput,
  MetricSelectorOutput,
  MetricSelectorConfig
>['create'] = async (rawConfig, services) => {
  const config = parseConfig<ResolvedMetricSelectorConfig>(
    configSchema,
    rawConfig,
    'metric selector config',
  );
  const constraints = config.constraints;
  for (const c of constraints)
    if (c.min !== undefined && c.max !== undefined && c.min > c.max)
      throw new Error(`Constraint ${c.metric} min exceeds max`);
  return {
    async execute(input, context: RuntimeContext) {
      validate(
        metricSelectorContract.input_schema,
        input,
        'metric selector input',
      );
      json(input);
      const refs = [
        string(input.incumbentMeasurementRef),
        string(input.candidateMeasurementRef),
      ];
      const [before, after] = await Promise.all(
        refs.map((ref) => context.readMeasurement(ref)),
      );
      validateMeasurement(before);
      validateMeasurement(after);
      if (
        before.ref !== refs[0] ||
        after.ref !== refs[1] ||
        before.experimentId !== context.experimentId ||
        after.experimentId !== context.experimentId
      )
        throw new Error(
          'Measurement identity or experiment ownership mismatch',
        );
      assertComparable(before, after, 'Measurements');
      const itemId = config.itemId;
      const [a, b] = await Promise.all([
        scope(services, before, itemId),
        scope(services, after, itemId),
      ]);
      if (itemId !== undefined) {
        assertComparable(a, b, 'Measurement points');
        if (object(a.subject).kind !== object(b.subject).kind)
          throw new Error('Measurement point subject kinds differ');
      }
      const metric = config.metric,
        statistic = config.statistic;
      const objective = await comparableValues(
        services,
        a,
        b,
        metric,
        statistic,
      );
      const checks: JsonObject[] = [];
      for (const constraint of constraints) {
        const id = constraint.metric,
          stat = constraint.statistic;
        const values = await comparableValues(services, a, b, id, stat);
        const min = constraint.min ?? null,
          max = constraint.max ?? null;
        checks.push({
          metric: id,
          statistic: stat ?? null,
          definitionRef: values.definitionRef,
          min,
          max,
          incumbentValue: values.before,
          candidateValue: values.after,
          passed:
            (min === null || values.after >= min) &&
            (max === null || values.after <= max),
        });
      }
      const feasible = checks.every((c) => c.passed === true);
      const improved =
        config.direction === 'minimize'
          ? objective.after < objective.before
          : objective.after > objective.before;
      const accepted = feasible && improved;
      const reason = !feasible
        ? 'Candidate does not satisfy metric constraints'
        : accepted
          ? 'Candidate metric strictly improves'
          : objective.after === objective.before
            ? 'Metrics are equal; retain the incumbent'
            : 'Candidate does not strictly improve; retain the incumbent';
      const selected = accepted ? after : before;
      const decision = {
        kind: 'metric-decision',
        measurementRefs: refs,
        itemId: itemId ?? null,
        metric,
        statistic: statistic ?? null,
        direction: config.direction,
        tieBreak: config.tieBreak,
        definitionRef: objective.definitionRef,
        incumbentValue: objective.before,
        candidateValue: objective.after,
        constraints: checks,
        accepted,
        reason,
      };
      validate(metricDecisionSchema, decision, 'Metric decision');
      const decisionRef = await services.artifacts.putJson(decision);
      return {
        accepted,
        candidateFeasible: feasible,
        selectedCandidateRef: string(selected.candidateRef),
        measurementRef: accepted ? refs[1]! : refs[0]!,
        decisionRef,
        reason,
        metric,
        incumbentValue: objective.before,
        candidateValue: objective.after,
        selectedValue: accepted ? objective.after : objective.before,
      };
    },
    async dispose() {},
  };
};
