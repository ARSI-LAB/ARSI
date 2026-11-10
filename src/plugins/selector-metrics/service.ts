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
  type MetricConstraint,
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
type MetricCheck = JsonObject & {
  incumbentValue: number;
  candidateValue: number;
  min: number | null;
  max: number | null;
  passed: boolean;
};
async function metricChecks(
  services: RuntimeContext,
  before: JsonObject,
  after: JsonObject,
  constraints: MetricConstraint[],
): Promise<MetricCheck[]> {
  const checks: MetricCheck[] = [];
  for (const constraint of constraints) {
    const values = await comparableValues(
      services,
      before,
      after,
      constraint.metric,
      constraint.statistic,
    );
    const min = constraint.min ?? null,
      max = constraint.max ?? null;
    checks.push({
      metric: constraint.metric,
      prerequisite: constraint.prerequisite ?? false,
      statistic: constraint.statistic ?? null,
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
  return checks;
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
  const prerequisites = config.constraints.filter(
    (constraint) => constraint.prerequisite,
  );
  const ordinaryConstraints = config.constraints.filter(
    (constraint) => !constraint.prerequisite,
  );
  for (const c of config.constraints)
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
      const hasPrerequisites = prerequisites.length > 0;
      if (hasPrerequisites) {
        assertComparable(before, before, 'Incumbent measurements');
        if (
          before.finishedAt === null ||
          after.finishedAt === null ||
          after.status !== 'succeeded'
        )
          throw new Error(
            'Metric prerequisites require completed, succeeded assessments',
          );
      } else {
        assertComparable(before, after, 'Measurements');
      }
      const itemId = config.itemId;
      const [a, b] = await Promise.all([
        scope(services, before, itemId),
        scope(services, after, itemId),
      ]);
      if (itemId !== undefined) {
        if (hasPrerequisites) {
          assertComparable(a, a, 'Incumbent measurement points');
          if (b.status !== 'succeeded')
            throw new Error(
              'Metric prerequisites require a succeeded point assessment',
            );
        } else {
          assertComparable(a, b, 'Measurement points');
        }
        if (object(a.subject).kind !== object(b.subject).kind)
          throw new Error('Measurement point subject kinds differ');
      }
      const metric = config.metric,
        statistic = config.statistic;
      const prerequisiteChecks = await metricChecks(
        services,
        a,
        b,
        prerequisites,
      );
      if (
        prerequisiteChecks.some(
          (check) =>
            (check.min !== null && check.incumbentValue < check.min) ||
            (check.max !== null && check.incumbentValue > check.max),
        )
      )
        throw new Error('Incumbent does not satisfy metric prerequisites');
      const eligible = prerequisiteChecks.every((check) => check.passed);
      let objective: {
        before: number;
        after: number | null;
        definitionRef: string;
      };
      if (eligible) {
        if (hasPrerequisites) {
          assertComparable(before, after, 'Measurements');
          if (itemId !== undefined)
            assertComparable(a, b, 'Measurement points');
        }
        objective = await comparableValues(services, a, b, metric, statistic);
      } else {
        const incumbent = await comparableValues(
          services,
          a,
          a,
          metric,
          statistic,
        );
        objective = { ...incumbent, after: null };
      }
      if (config.minRelativeImprovement > 0 && objective.before <= 0)
        throw new Error(
          'Relative improvement requires a positive incumbent value',
        );
      const ordinaryChecks = eligible
        ? await metricChecks(services, a, b, ordinaryConstraints)
        : [];
      const feasible =
        eligible && ordinaryChecks.every((check) => check.passed);
      const requiredImprovement =
        objective.before * config.minRelativeImprovement;
      // Compare the cutoff directly to avoid subtraction noise at equal thresholds.
      const improved =
        objective.after !== null &&
        (config.direction === 'minimize'
          ? objective.after < objective.before - requiredImprovement
          : objective.after > objective.before + requiredImprovement);
      const accepted = feasible && improved;
      const reason = !eligible
        ? 'Candidate does not satisfy metric prerequisites'
        : !feasible
          ? 'Candidate does not satisfy metric constraints'
          : accepted
            ? 'Candidate metric strictly improves'
            : objective.after === objective.before
              ? 'Metrics are equal; retain the incumbent'
              : config.minRelativeImprovement > 0
                ? 'Candidate does not exceed the relative improvement threshold; retain the incumbent'
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
        minRelativeImprovement: config.minRelativeImprovement,
        definitionRef: objective.definitionRef,
        incumbentValue: objective.before,
        candidateValue: objective.after,
        constraints: [...prerequisiteChecks, ...ordinaryChecks],
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
        selectedValue:
          accepted && objective.after !== null
            ? objective.after
            : objective.before,
      };
    },
    async dispose() {},
  };
};
