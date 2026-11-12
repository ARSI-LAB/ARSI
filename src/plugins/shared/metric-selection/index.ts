import { metricDecisionSchema } from '../metric-decision/index.js';
import type {
  RuntimeContext,
  JsonObject,
  MetricSelectorInput,
  MetricSelectorOutput,
  Operation,
} from '../../../contracts/index.js';
import {
  measurementItemsSchema,
  metricDefinitionSchema,
  validateMeasurement,
} from '../../../contracts/models/measurement.js';
import { json, object, string } from '../../../shared/json.js';
import { parseConfig, validate } from '../../../shared/schema.js';
import {
  configSchema,
  type MetricConstraint,
  type MetricSelectorConfig,
  type ResolvedMetricSelectorConfig,
} from './schema.js';
import { metricSelectorContract } from '../../../contracts/plugin-types/index.js';
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
export type MetricCheck = JsonObject & {
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
      statistic: constraint.statistic ?? null,
      definitionRef: values.definitionRef,
      min,
      max,
      exclusiveMax: constraint.exclusiveMax ?? false,
      incumbentValue: values.before,
      candidateValue: values.after,
      passed:
        (min === null || values.after >= min) &&
        (max === null ||
          (constraint.exclusiveMax ? values.after < max : values.after <= max)),
    });
  }
  return checks;
}
export interface MetricComparison {
  eligible: boolean;
  feasible: boolean;
  improved: boolean;
  incumbentValue: number;
  candidateValue: number | null;
  constraints: readonly MetricCheck[];
  minRelativeImprovement: number;
}
export interface MetricAcceptance {
  accepted: boolean;
  reason: string;
}

/** Both selectors share measurement validation and the persisted decision protocol. */
export async function createMetricSelection(
  rawConfig: MetricSelectorConfig,
  services: RuntimeContext,
  decide: (comparison: MetricComparison) => MetricAcceptance,
  rejectFailedCandidates = false,
): Promise<Operation<MetricSelectorInput, MetricSelectorOutput>> {
  const config = parseConfig<ResolvedMetricSelectorConfig>(
    configSchema,
    rawConfig,
    'metric selector config',
  );
  const constraints = config.constraints;
  for (const c of [...config.eligibility, ...constraints]) {
    if (c.exclusiveMax && c.max === undefined)
      throw new Error(`Constraint ${c.metric} exclusiveMax requires max`);
    if (c.min !== undefined && c.max !== undefined && c.min > c.max)
      throw new Error(`Constraint ${c.metric} min exceeds max`);
  }
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
      if (
        rejectFailedCandidates &&
        after.status === 'failed' &&
        after.finishedAt !== null &&
        refs[0] !== refs[1]
      ) {
        assertComparable(before, before, 'Incumbent measurements');
        const incumbent = await scope(services, before, config.itemId);
        const value = await comparableValues(
          services,
          incumbent,
          incumbent,
          config.metric,
          config.statistic,
        );
        const reason =
          'Candidate evaluation failed; retain the measured incumbent';
        const decision = {
          kind: 'metric-decision',
          measurementRefs: refs,
          itemId: config.itemId ?? null,
          metric: config.metric,
          statistic: config.statistic ?? null,
          direction: config.direction,
          definitionRef: value.definitionRef,
          incumbentValue: value.before,
          candidateValue: null,
          minRelativeImprovement: config.minRelativeImprovement,
          constraints: [],
          eligibility: [],
          accepted: false,
          tieBreak: config.tieBreak,
          reason,
        };
        validate(metricDecisionSchema, decision, 'Metric decision');
        const decisionRef = await services.artifacts.putJson(decision);
        return {
          accepted: false,
          candidateFeasible: false,
          selectedCandidateRef: string(before.candidateRef),
          measurementRef: refs[0]!,
          decisionRef,
          reason,
          metric: config.metric,
          incumbentValue: value.before,
          selectedValue: value.before,
          candidateValue: null,
        };
      }
      const hasEligibility = config.eligibility.length > 0;
      if (hasEligibility) {
        assertComparable(before, before, 'Incumbent measurements');
        if (
          before.finishedAt === null ||
          after.finishedAt === null ||
          after.status !== 'succeeded'
        )
          throw new Error(
            'Eligibility requires completed, succeeded assessments',
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
        if (hasEligibility) {
          assertComparable(a, a, 'Incumbent measurement points');
          if (b.status !== 'succeeded')
            throw new Error(
              'Eligibility requires a succeeded point assessment',
            );
        } else {
          assertComparable(a, b, 'Measurement points');
        }
        if (object(a.subject).kind !== object(b.subject).kind)
          throw new Error('Measurement point subject kinds differ');
      }
      const metric = config.metric,
        statistic = config.statistic;
      const eligibilityChecks = await metricChecks(
        services,
        a,
        b,
        config.eligibility,
      );
      if (
        eligibilityChecks.some(
          (check) =>
            (check.min !== null && check.incumbentValue < check.min) ||
            (check.max !== null &&
              (check.exclusiveMax
                ? check.incumbentValue >= check.max
                : check.incumbentValue > check.max)),
        )
      )
        throw new Error('Incumbent does not satisfy metric eligibility');
      const eligible = eligibilityChecks.every((check) => check.passed);
      let objective: {
        before: number;
        after: number | null;
        definitionRef: string;
      };
      if (eligible) {
        if (hasEligibility) {
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
      const checks = eligible
        ? await metricChecks(services, a, b, constraints)
        : [];
      const feasible = eligible && checks.every((check) => check.passed);
      const requiredImprovement =
        objective.before * config.minRelativeImprovement;
      // Compare the cutoff directly to avoid subtraction noise at equal thresholds.
      const improved =
        objective.after !== null &&
        (config.direction === 'minimize'
          ? objective.after < objective.before - requiredImprovement
          : objective.after > objective.before + requiredImprovement);
      const { accepted, reason } = decide({
        eligible,
        feasible,
        improved,
        incumbentValue: objective.before,
        candidateValue: objective.after,
        constraints: checks,
        minRelativeImprovement: config.minRelativeImprovement,
      });
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
        eligibility: eligibilityChecks,
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
        selectedValue:
          accepted && objective.after !== null
            ? objective.after
            : objective.before,
      };
    },
    async dispose() {},
  };
}
