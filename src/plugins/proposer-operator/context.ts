import { createHash } from 'node:crypto';
import type {
  Candidate,
  JsonObject,
  RuntimeContext,
} from '../../contracts/index.js';
import { parseFileTree } from '../../contracts/models/file-tree.js';
import { validateMeasurement } from '../../contracts/models/measurement.js';
import { canonical, digest, object, string } from '../../shared/json.js';
import { parseConfig, validate } from '../../shared/schema.js';
import {
  metricDecisionSchema,
  readDecisionFeedback,
} from '../shared/metric-decision/index.js';
import {
  analysisSchema,
  historySchema,
  staticDiagnosisSchema,
  summarySchema,
  type StaticIssue,
  type OperatorAnalysis,
  type OperatorAnalysisIdentity,
  type OperatorHistory,
  type OperatorHistoryArtifact,
  type OperatorSummary,
} from './schema.js';

/** Validate model data before interpreting it as source-backed diagnoses. */
export function parseStaticDiagnosis(
  raw: unknown,
  source: string,
): StaticIssue[] {
  const value: unknown = structuredClone(raw);
  validate(staticDiagnosisSchema, value, 'Static diagnosis');
  // The schema above owns this external JSON/type pairing.
  const issues = value as StaticIssue[];
  for (const issue of issues) {
    if (!issue.issue_summary.trim() || issue.evidence.some((e) => !e.trim()))
      throw new Error(
        'Static diagnosis requires nonempty evidence and summary',
      );
    for (const snippet of issue.problematic_code)
      if (!snippet.trim() || !source.includes(snippet))
        throw new Error(
          'Static diagnosis code snippet does not occur in the source',
        );
  }
  return issues;
}
function assertOwned(
  value: { experimentId?: unknown },
  context: RuntimeContext,
): void {
  if (value.experimentId !== context.experimentId)
    throw new Error('Operator context experiment ownership mismatch');
}
async function ownedCandidate(
  ref: string,
  context: RuntimeContext,
): Promise<Candidate> {
  const candidate = await context.readCandidate(ref);
  assertOwned(candidate, context);
  if (candidate.ref !== ref)
    throw new Error('Operator candidate identity mismatch');
  return candidate;
}
async function ownedMeasurement(
  ref: string,
  context: RuntimeContext,
): Promise<JsonObject> {
  const measurement = await context.readMeasurement(ref);
  validateMeasurement(measurement);
  assertOwned(measurement, context);
  if (measurement.ref !== ref)
    throw new Error('Operator measurement identity mismatch');
  if (object(measurement.evaluator).pluginId !== 'evaluator.operatorbench')
    throw new Error('Operator context requires an operatorbench measurement');
  return measurement;
}
function scalar(measurement: JsonObject, name: string): number | null {
  const metric = object(
    object(measurement.metrics)[name],
    `Operator metric ${name}`,
  );
  if (metric.status === 'unavailable') return null;
  const value = object(metric.value);
  if (
    metric.status !== 'available' ||
    value.kind !== 'scalar' ||
    typeof value.value !== 'number' ||
    !Number.isFinite(value.value)
  )
    throw new Error(`Operator metric ${name} must be a finite scalar`);
  return value.value;
}
async function sourceOf(
  candidate: Candidate,
  context: RuntimeContext,
): Promise<{ source: string; digest: string }> {
  const tree = parseFileTree(
    await context.artifacts.readJson(candidate.artifactRef),
  );
  const file = tree.files.find((f) => f.path === 'input.py');
  if (!file) throw new Error('Operator candidate lacks input.py');
  const bytes = Buffer.from(file.base64, 'base64');
  return {
    source: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
}
async function assertConfirmed(
  measurement: JsonObject,
  candidate: Candidate,
  context: RuntimeContext,
): Promise<void> {
  if (measurement.candidateRef !== candidate.ref)
    throw new Error('Operator measurement candidate mismatch');
  if (measurement.status !== 'succeeded' || measurement.finishedAt === null)
    throw new Error('Operator context requires a completed assessment');
  const provenance = object(
    await context.artifacts.readJson(
      string(object(measurement.provenance).artifactRef),
    ),
  );
  const source = await sourceOf(candidate, context);
  if (
    provenance.mode !== 'sdk' ||
    provenance.cleanup !== 'confirmed' ||
    provenance.artifactRef !== candidate.artifactRef ||
    provenance.sourceDigest !== source.digest
  )
    throw new Error('Operator measurement source or cleanup mismatch');
}

/** Resolve an immutable analysis against the explicit baseline and current resource identity. */
export async function readAnalysis(
  ref: string,
  expectedIdentity: OperatorAnalysisIdentity,
  context: RuntimeContext,
): Promise<OperatorAnalysis> {
  context.signal.throwIfAborted();
  const analysis = parseConfig<OperatorAnalysis>(
    analysisSchema,
    await context.artifacts.readJson(ref),
    'Operator analysis',
  );
  assertOwned(analysis, context);
  if (canonical(analysis.identity) !== canonical(expectedIdentity))
    throw new Error('Operator analysis identity mismatch');
  const identity = analysis.identity;
  const candidate = await ownedCandidate(identity.entryCandidateRef, context);
  const measurement = await ownedMeasurement(
    identity.baselineMeasurementRef,
    context,
  );
  await assertConfirmed(measurement, candidate, context);
  if (
    measurement.coverage !== 'complete' ||
    scalar(measurement, 'candidateValid') !== 1
  )
    throw new Error('Operator baseline must pass correctness');
  const source = await sourceOf(candidate, context);
  if (source.digest !== identity.sourceDigest)
    throw new Error('Operator analysis source identity mismatch');
  if (scalar(measurement, 'latencyMeanMs') !== analysis.baselineMs)
    throw new Error('Operator analysis baseline latency mismatch');
  const conditions = object(
    await context.artifacts.readJson(
      string(object(measurement.conditions).artifactRef),
    ),
  );
  const evaluation = object(conditions.evaluation);
  if (
    conditions.mode !== 'sdk' ||
    measurement.comparisonKey !== identity.comparisonKey ||
    digest(conditions) !== identity.comparisonKey ||
    conditions.taskDigest !== identity.taskDigest ||
    digest(object(evaluation.contract)) !== identity.contractDigest ||
    digest(object(evaluation.environment)) !== identity.environmentDigest ||
    digest(object(evaluation.protocol)) !== identity.protocolDigest
  )
    throw new Error('Operator analysis effective condition identity mismatch');
  analysis.issues = parseStaticDiagnosis(analysis.issues, source.source);
  const techniques = new Set<string>();
  for (const match of analysis.matches) {
    if (
      techniques.has(match.techniqueId) ||
      match.issueIndexes.some(
        (index) => analysis.issues[index]?.issue_type !== match.techniqueId,
      )
    )
      throw new Error(
        'Operator analysis knowledge match does not correspond to its diagnosis',
      );
    techniques.add(match.techniqueId);
  }
  if (!analysis.matches.length && analysis.knowledgeContext.length)
    throw new Error(
      'Operator analysis has knowledge context without matched techniques',
    );
  context.signal.throwIfAborted();
  return analysis;
}

async function readSummary(
  ref: string,
  analysisRef: string,
  analysis: OperatorAnalysis,
  baselineConditions: JsonObject,
  context: RuntimeContext,
): Promise<OperatorSummary> {
  const summary = parseConfig<OperatorSummary>(
    summarySchema,
    await context.artifacts.readJson(ref),
    'Operator summary',
  );
  assertOwned(summary, context);
  if (
    summary.analysisRef !== analysisRef ||
    summary.facts.baselineMs !== analysis.baselineMs
  )
    throw new Error('Operator summary analysis or baseline mismatch');
  if (
    summary.techniqueIds.some(
      (id) => !analysis.issues.some((issue) => issue.issue_type === id),
    )
  )
    throw new Error(
      'Operator summary names a technique unsupported by its diagnosis',
    );
  const candidates: Candidate[] = [];
  for (const candidateRef of summary.candidateRefs) {
    const candidate = await ownedCandidate(candidateRef, context);
    const parent =
      candidates.at(-1)?.ref ?? analysis.identity.entryCandidateRef;
    if (
      !(candidates.length === 0 && candidate.ref === parent) &&
      candidate.parentRef !== parent
    )
      throw new Error('Operator summary candidate chain mismatch');
    candidates.push(candidate);
  }
  const { facts } = summary;
  if (['no-change', 'proposal-failed'].includes(facts.outcome)) {
    if (
      candidates.length !== 1 ||
      candidates[0]!.ref !== analysis.identity.entryCandidateRef ||
      summary.measurementRefs.length ||
      summary.decisionRef !== null ||
      facts.wasTransformCorrect !== null ||
      facts.candidateMs !== null ||
      facts.accepted
    )
      throw new Error(
        'Operator no-change summary cannot claim an assessment or acceptance',
      );
    return summary;
  }
  if (candidates[0]!.ref === analysis.identity.entryCandidateRef)
    throw new Error(
      'Operator measured attempt must start with a new candidate',
    );
  if (summary.measurementRefs.length !== candidates.length)
    throw new Error(
      'Operator summary requires the measurement for each candidate',
    );
  const measurements: JsonObject[] = [];
  for (const [index, measurementRef] of summary.measurementRefs.entries()) {
    const measurement = await ownedMeasurement(measurementRef, context);
    await assertConfirmed(measurement, candidates[index]!, context);
    const conditions = object(
      await context.artifacts.readJson(
        string(object(measurement.conditions).artifactRef),
      ),
    );
    for (const field of [
      'mode',
      'taskDigest',
      'adapterDigest',
      'sdkBuildDigest',
    ])
      if (conditions[field] !== baselineConditions[field])
        throw new Error(
          'Operator history assessment condition identity mismatch',
        );
    if (
      scalar(measurement, 'candidateValid') === 1 &&
      (measurement.comparisonKey !== digest(conditions) ||
        measurement.comparisonKey !== analysis.identity.comparisonKey)
    )
      throw new Error('Operator history timing condition identity mismatch');
    if (
      index < candidates.length - 1 &&
      scalar(measurement, 'candidateValid') !== 0
    )
      throw new Error('Operator repair requires a confirmed candidate failure');
    measurements.push(measurement);
  }
  const last = measurements.at(-1)!;
  const correct = scalar(last, 'candidateValid');
  if (correct !== 0 && correct !== 1)
    throw new Error('Operator summary lacks a correctness result');
  const wasCorrect = correct === 1;
  const candidateMs = scalar(last, 'latencyMeanMs');
  if (
    facts.wasTransformCorrect !== wasCorrect ||
    facts.candidateMs !== candidateMs
  )
    throw new Error(
      'Operator summary correctness or latency does not match its measurement',
    );
  if (!wasCorrect) {
    if (
      facts.outcome !== 'verification-failed' ||
      facts.accepted ||
      summary.decisionRef !== null ||
      candidateMs !== null
    )
      throw new Error(
        'Operator failed verification cannot claim timing, selection or acceptance',
      );
  } else {
    if (
      last.coverage !== 'complete' ||
      candidateMs === null ||
      candidateMs <= 0 ||
      last.comparisonKey !== analysis.identity.comparisonKey ||
      summary.decisionRef === null
    )
      throw new Error(
        'Operator valid summary requires comparable timing and selection',
      );
    const decision = object(
      await context.artifacts.readJson(summary.decisionRef),
    );
    validate(metricDecisionSchema, decision, 'Operator metric decision');
    if (
      !Array.isArray(decision.measurementRefs) ||
      decision.measurementRefs[0] !==
        analysis.identity.baselineMeasurementRef ||
      decision.metric !== 'latencyMeanMs' ||
      decision.statistic !== null ||
      decision.direction !== 'minimize' ||
      decision.itemId !== null ||
      decision.incumbentValue !== analysis.baselineMs
    )
      throw new Error(
        'Operator summary decision baseline or objective mismatch',
      );
    const feedback = await readDecisionFeedback(
      string(last.ref),
      summary.decisionRef,
      candidates.at(-1)!.ref,
      context,
    );
    const accepted =
      candidateMs <
        analysis.baselineMs -
          analysis.baselineMs * Number(decision.minRelativeImprovement ?? 0) &&
      feedback.constraints.every((v) => v <= 0);
    if (
      facts.accepted !== decision.accepted ||
      decision.accepted !== accepted ||
      facts.outcome !== (accepted ? 'adopted' : 'verified-no-gain')
    )
      throw new Error(
        'Operator summary acceptance does not match its decision',
      );
  }
  return summary;
}

/** Read ordered summaries and verify their owned immutable facts before reuse. */
export async function readHistory(
  ref: string,
  context: RuntimeContext,
): Promise<OperatorHistory> {
  context.signal.throwIfAborted();
  const history = parseConfig<OperatorHistoryArtifact>(
    historySchema,
    await context.artifacts.readJson(ref),
    'Operator history',
  );
  assertOwned(history, context);
  const stored = parseConfig<OperatorAnalysis>(
    analysisSchema,
    await context.artifacts.readJson(history.analysisRef),
    'Operator analysis',
  );
  const analysis = await readAnalysis(
    history.analysisRef,
    stored.identity,
    context,
  );
  const baseline = await ownedMeasurement(
    analysis.identity.baselineMeasurementRef,
    context,
  );
  const baselineConditions = object(
    await context.artifacts.readJson(
      string(object(baseline.conditions).artifactRef),
    ),
  );
  const summaries: OperatorSummary[] = [];
  for (const summaryRef of history.summaryRefs) {
    const summary = await readSummary(
      summaryRef,
      history.analysisRef,
      analysis,
      baselineConditions,
      context,
    );
    if (summary.attempt !== summaries.length + 1)
      throw new Error('Operator history attempt order mismatch');
    summaries.push(summary);
  }
  context.signal.throwIfAborted();
  return { ...history, summaries };
}
