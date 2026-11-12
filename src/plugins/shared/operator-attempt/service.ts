import { createHash } from 'node:crypto';
import {
  type Candidate,
  type JsonObject,
  type JsonValue,
  type RuntimeContext,
} from '../../../contracts/index.js';
import { parseFileTree } from '../../../contracts/models/file-tree.js';
import { validateMeasurement } from '../../../contracts/models/measurement.js';
import { canonical, digest, object, string } from '../../../shared/json.js';
import { parseConfig, validate } from '../../../shared/schema.js';
import { kernelBundleDigest } from '../../application-kernel/schema.js';
import {
  canModifyTargetFile,
  parseTarget,
} from '../file-application/target.js';
import { readDecisionFeedback } from '../metric-decision/index.js';
import {
  type StaticIssue,
  type OperatorAnalysisIdentity,
  type OperatorAnalysis,
  type OperatorSummary,
  type OperatorHistoryArtifact,
  type OperatorHistory,
  staticDiagnosisSchema,
  analysisSchema,
  summarySchema,
  historySchema,
  type MetricsDiagnosis,
  type MetricsAnalysis,
  type MetricsSummary,
  type MetricsHistory,
  metricsDiagnosisSchema,
  metricsAnalysisSchema,
  metricsSummarySchema,
  metricsHistorySchema,
  type OperatorAttempt,
  type OperatorInsight,
} from './schema.js';

export function assertSummaryEvidence(
  summary: {
    lessons: OperatorInsight[];
    avoidPatterns: OperatorInsight[];
    tryPatterns: OperatorInsight[];
  },
  measurementRefs: string[],
): void {
  if (
    !measurementRefs.length &&
    [...summary.lessons, ...summary.avoidPatterns, ...summary.tryPatterns].some(
      (item) => item.basis === 'evaluation',
    )
  )
    throw new Error('Summary evaluation claims require an attempt measurement');
}

export async function readOperatorCandidate(
  ref: string,
  context: RuntimeContext,
): Promise<Candidate> {
  const candidate = await context.readCandidate(ref);
  if (candidate.ref !== ref || candidate.experimentId !== context.experimentId)
    throw new Error('Operator candidate ownership mismatch');
  return candidate;
}

type OperatorSource = {
  sourcePath: string;
  source: string;
  identity: Pick<
    OperatorAnalysisIdentity,
    'sourceDigest' | 'sourceBundleDigest'
  >;
  files: Record<string, string>;
  editablePaths: string[];
};

export function matchesOperatorSource(
  record: JsonObject,
  source: OperatorSource,
): boolean {
  return (
    record.sourceDigest === source.identity.sourceDigest &&
    record.sourceBundleDigest === source.identity.sourceBundleDigest
  );
}

export async function readOperatorSource(
  candidate: Candidate,
  assessment: JsonObject,
  context: RuntimeContext,
): Promise<OperatorSource> {
  const tree = parseFileTree(
    await context.artifacts.readJson(candidate.artifactRef),
  );
  const metadata = await context.applicationMetadata();
  const conditions = await readOperatorArtifact(
    assessment,
    'conditions',
    context,
  );
  const evaluation = object(conditions.evaluation, 'Operator evaluation');
  const layout = object(evaluation.candidateLayout, 'Operator candidateLayout');
  const sourcePath = string(
    layout.entryFile,
    'Operator candidateLayout.entryFile',
  );
  const target = parseTarget(metadata.target);
  const files: Record<string, string> = Object.create(null);
  const sourceFiles = tree.files.map((file) => {
    const path = file.path;
    const bytes = Buffer.from(file.base64, 'base64');
    files[path] = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  return {
    sourcePath,
    source: Object.values(files).join('\n'),
    identity: {
      sourceDigest: string(
        sourceFiles.find((file) => file.path === sourcePath)?.sha256,
        'Operator entry digest',
      ),
      sourceBundleDigest: kernelBundleDigest(sourcePath, sourceFiles),
    },
    files,
    editablePaths: sourceFiles
      .map((file) => file.path)
      .filter((path) => canModifyTargetFile(target, path)),
  };
}

export async function readOperatorMeasurement(
  ref: string,
  context: RuntimeContext,
): Promise<JsonObject> {
  const measurement = await context.readMeasurement(ref);
  validateMeasurement(measurement);
  if (
    measurement.ref !== ref ||
    measurement.experimentId !== context.experimentId
  )
    throw new Error('Operator measurement ownership mismatch');
  if (object(measurement.evaluator).pluginId !== 'evaluator.operatorbench')
    throw new Error('Operator context requires an operatorbench measurement');
  return measurement;
}

export async function readOperatorArtifact(
  measurement: JsonObject,
  key: string,
  context: RuntimeContext,
): Promise<JsonObject> {
  return object(
    await context.artifacts.readJson(
      string(object(measurement[key]).artifactRef),
    ),
  );
}

/** A completed assessment can report candidate invalidity, but cannot have unknown cleanup. */
export async function readAssessment(
  ref: string,
  candidateRef: string,
  context: RuntimeContext,
): Promise<JsonObject> {
  const candidate = await readOperatorCandidate(candidateRef, context);
  const measurement = await readOperatorMeasurement(ref, context);
  const provenance = await readOperatorArtifact(
    measurement,
    'provenance',
    context,
  );
  const source = await readOperatorSource(candidate, measurement, context);
  if (
    measurement.candidateRef !== candidateRef ||
    measurement.status !== 'succeeded' ||
    measurement.finishedAt === null ||
    provenance.mode !== 'sdk' ||
    provenance.cleanup !== 'confirmed' ||
    provenance.artifactRef !== candidate.artifactRef ||
    !matchesOperatorSource(provenance, source)
  )
    throw new Error(
      'Operator assessment candidate, source or cleanup mismatch',
    );
  return measurement;
}

export function operatorScalar(
  measurement: JsonObject,
  name: string,
): number | null {
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

/** Invalid candidates still need the same task and build, even though timing is unavailable. */
export function assertOperatorConditions(
  before: JsonObject,
  after: JsonObject,
): void {
  for (const field of ['mode', 'taskDigest', 'adapterDigest', 'sdkBuildDigest'])
    if (before[field] !== after[field])
      throw new Error(
        'Operator assessment condition, task or build identity mismatch',
      );
}

/** Derive facts for both new summaries and persisted histories from their owned evidence. */
export async function readAttemptFacts(
  attempt: OperatorAttempt,
  context: RuntimeContext,
): Promise<MetricsSummary['facts']> {
  const baseline = await readAssessment(
    attempt.baselineMeasurementRef,
    attempt.rootCandidateRef,
    context,
  );
  const before = operatorScalar(baseline, 'latencyMeanMs');
  if (
    operatorScalar(baseline, 'candidateValid') !== 1 ||
    before === null ||
    before <= 0
  )
    throw new Error('Operator baseline requires correct, positive timing');
  const facts: MetricsSummary['facts'] = {
    outcome: attempt.outcome,
    wasTransformCorrect: null,
    baselineMs: before,
    candidateMs: null,
    improvement: null,
    accepted: false,
    selectedCandidateRef: attempt.rootCandidateRef,
  };
  if (['no-change', 'proposal-failed'].includes(attempt.outcome)) {
    if (
      attempt.measurementRefs.length ||
      attempt.decisionRef !== null ||
      (attempt.phase === 'static'
        ? attempt.candidateRefs.length !== 1
        : attempt.candidateRefs.length > 1) ||
      attempt.candidateRefs.some((ref) => ref !== attempt.rootCandidateRef)
    )
      throw new Error(
        'Operator no-change attempt cannot claim a candidate, assessment or acceptance',
      );
    return facts;
  }
  if (
    !attempt.candidateRefs.length ||
    attempt.candidateRefs.length !== attempt.measurementRefs.length
  )
    throw new Error('Operator candidate assessment coverage mismatch');
  const beforeConditions = await readOperatorArtifact(
    baseline,
    'conditions',
    context,
  );
  let parentRef = attempt.rootCandidateRef;
  for (let index = 0; index < attempt.candidateRefs.length; index++) {
    const candidate = await readOperatorCandidate(
      attempt.candidateRefs[index]!,
      context,
    );
    if (
      candidate.ref === attempt.rootCandidateRef ||
      candidate.parentRef !== parentRef
    )
      throw new Error('Operator candidate repair chain mismatch');
    parentRef = candidate.ref;
    const measured = await readAssessment(
      attempt.measurementRefs[index]!,
      candidate.ref,
      context,
    );
    const conditions = await readOperatorArtifact(
      measured,
      'conditions',
      context,
    );
    assertOperatorConditions(beforeConditions, conditions);
    const correct = operatorScalar(measured, 'candidateValid');
    if (correct !== 0 && correct !== 1)
      throw new Error('Operator summary correctness unavailable');
    const latency = operatorScalar(measured, 'latencyMeanMs');
    if (
      correct === 1 &&
      (measured.coverage !== 'complete' ||
        latency === null ||
        latency <= 0 ||
        typeof baseline.comparisonKey !== 'string' ||
        measured.comparisonKey !== baseline.comparisonKey ||
        measured.comparisonKey !== digest(conditions))
    )
      throw new Error('Operator candidate timing condition identity mismatch');
    if (index < attempt.candidateRefs.length - 1) {
      if (correct !== 0)
        throw new Error(
          'Operator repair requires a confirmed candidate failure',
        );
      continue;
    }
    facts.wasTransformCorrect = correct === 1;
    facts.candidateMs = latency;
  }
  if (!facts.wasTransformCorrect) {
    if (
      attempt.outcome !== 'verification-failed' ||
      attempt.decisionRef !== null ||
      facts.candidateMs !== null
    )
      throw new Error(
        'Operator failed verification cannot claim timing, selection or acceptance',
      );
    return facts;
  }
  if (attempt.decisionRef === null)
    throw new Error('Operator valid summary requires selection');
  // The shared reader validates the decision Schema and actual candidate metric/constraints.
  const decision = object(
    await context.artifacts.readJson(attempt.decisionRef),
  );
  const feedback = await readDecisionFeedback(
    attempt.measurementRefs.at(-1)!,
    attempt.decisionRef,
    attempt.candidateRefs.at(-1)!,
    context,
  );
  if (
    !Array.isArray(decision.measurementRefs) ||
    decision.measurementRefs[0] !== attempt.baselineMeasurementRef ||
    decision.metric !== 'latencyMeanMs' ||
    decision.statistic !== null ||
    decision.direction !== 'minimize' ||
    decision.itemId !== null ||
    decision.incumbentValue !== before
  )
    throw new Error('Operator summary decision baseline or objective mismatch');
  const after = facts.candidateMs;
  if (after === null)
    throw new Error('Operator valid summary candidate latency unavailable');
  facts.accepted =
    after < before - before * Number(decision.minRelativeImprovement) &&
    feedback.constraints.every((value) => value <= 0);
  if (
    facts.accepted !== decision.accepted ||
    attempt.outcome !== (facts.accepted ? 'adopted' : 'verified-no-gain')
  )
    throw new Error('Operator summary acceptance does not match its decision');
  facts.improvement = (before - after) / before;
  facts.selectedCandidateRef = facts.accepted
    ? attempt.candidateRefs.at(-1)!
    : attempt.rootCandidateRef;
  return facts;
}

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

/** Resolve an immutable analysis against the explicit baseline and current resource identity. */
export async function readAnalysis(
  ref: string,
  expectedIdentity: OperatorAnalysisIdentity | null,
  context: RuntimeContext,
): Promise<OperatorAnalysis> {
  context.signal.throwIfAborted();
  const analysis = parseConfig<OperatorAnalysis>(
    analysisSchema,
    await context.artifacts.readJson(ref),
    'Operator analysis',
  );
  assertOwned(analysis, context);
  if (
    expectedIdentity !== null &&
    canonical(analysis.identity) !== canonical(expectedIdentity)
  )
    throw new Error('Operator analysis identity mismatch');
  const identity = analysis.identity;
  const candidate = await readOperatorCandidate(
    identity.entryCandidateRef,
    context,
  );
  const measurement = await readAssessment(
    identity.baselineMeasurementRef,
    candidate.ref,
    context,
  );
  if (
    measurement.coverage !== 'complete' ||
    operatorScalar(measurement, 'candidateValid') !== 1
  )
    throw new Error('Operator baseline must pass correctness');
  const source = await readOperatorSource(candidate, measurement, context);
  if (!matchesOperatorSource(identity, source))
    throw new Error('Operator analysis source identity mismatch');
  if (operatorScalar(measurement, 'latencyMeanMs') !== analysis.baselineMs)
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
  const analysis = await readAnalysis(history.analysisRef, null, context);
  const summaries: OperatorSummary[] = [];
  for (const summaryRef of history.summaryRefs) {
    const summary = await readSummary(
      summaryRef,
      history.analysisRef,
      analysis,
      context,
    );
    if (summary.attempt !== summaries.length + 1)
      throw new Error('Operator history attempt order mismatch');
    summaries.push(summary);
  }
  context.signal.throwIfAborted();
  return { ...history, summaries };
}

/** Bind every model evidence value to a measured kernel metric, excluding assumed hardware ratios. */
export function parseMetricsDiagnosis(
  raw: unknown,
  profile: JsonObject,
): MetricsDiagnosis {
  const result = parseConfig<MetricsDiagnosis>(
    metricsDiagnosisSchema,
    raw,
    'Metric bottleneck',
  );
  if (result.status === 'no-new-hypothesis') return result;
  for (const evidence of result.evidence) {
    if (
      !/^\/kernels\/\d+\/metrics\/[^/]+\//.test(evidence.path) ||
      /(?:ub_ratio|core_utilization)/.test(evidence.path)
    )
      throw new Error(
        'Metric bottleneck evidence must reference an observed kernel metric',
      );
    let value: JsonValue = profile;
    for (const encoded of evidence.path.slice(1).split('/')) {
      const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
      if (Array.isArray(value)) value = value[Number(key)] ?? null;
      else if (value !== null && typeof value === 'object')
        value = object(value)[key] ?? null;
      else value = null;
    }
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value !== evidence.value
    )
      throw new Error(
        'Metric bottleneck evidence does not match its measured value',
      );
  }
  return result;
}

async function readSummary(
  ref: string,
  analysisRef: string,
  analysis: OperatorAnalysis,
  context: RuntimeContext,
): Promise<OperatorSummary> {
  const summary = parseConfig<OperatorSummary>(
    summarySchema,
    await context.artifacts.readJson(ref),
    'Operator summary',
  );
  assertOwned(summary, context);
  assertSummaryEvidence(summary, summary.measurementRefs);
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
  const facts = await readAttemptFacts(
    {
      ...summary,
      phase: 'static',
      rootCandidateRef: analysis.identity.entryCandidateRef,
      baselineMeasurementRef: analysis.identity.baselineMeasurementRef,
      outcome: summary.facts.outcome,
    },
    context,
  );
  if (canonical(summary.facts) !== canonical(staticFacts(facts)))
    throw new Error(
      'Operator summary facts, correctness or acceptance do not match measurement and decision',
    );
  return summary;
}

export function staticFacts(
  facts: MetricsSummary['facts'],
): OperatorSummary['facts'] {
  const { outcome, wasTransformCorrect, baselineMs, candidateMs, accepted } =
    facts;
  return { outcome, wasTransformCorrect, baselineMs, candidateMs, accepted };
}

export async function profile(
  ref: string,
  parent: Candidate,
  incumbent: JsonObject,
  context: RuntimeContext,
  requireUsable = true,
): Promise<JsonObject> {
  const measurement = await context.readMeasurement(ref);
  validateMeasurement(measurement);
  const provenance = await readOperatorArtifact(
    measurement,
    'provenance',
    context,
  );
  const conditions = await readOperatorArtifact(
    measurement,
    'conditions',
    context,
  );
  const expected = await readOperatorArtifact(incumbent, 'conditions', context);
  const details = await readOperatorArtifact(measurement, 'profile', context);
  const result = object(details.profile);
  const evaluation = object(conditions.evaluation);
  const checks = {
    ownership:
      measurement.experimentId === context.experimentId &&
      measurement.candidateRef === parent.ref,
    completion:
      measurement.status === 'succeeded' && measurement.finishedAt !== null,
    evaluator:
      object(measurement.evaluator).pluginId === 'evaluator.operatorbench',
    cleanup: provenance.cleanup === 'confirmed',
    artifact: provenance.artifactRef === parent.artifactRef,
    source: matchesOperatorSource(
      provenance,
      await readOperatorSource(parent, measurement, context),
    ),
    operation:
      details.operation === 'profile' && evaluation.operation === 'profile',
    task: conditions.taskDigest === expected.taskDigest,
    environment:
      canonical(evaluation.environment) ===
      canonical(object(expected.evaluation).environment),
    assessment: evaluation.assessmentMeasurementRef === incumbent.ref,
    comparison: evaluation.assessmentComparisonKey === incumbent.comparisonKey,
  };
  const mismatch = Object.entries(checks).find(([, matches]) => !matches);
  if (mismatch)
    throw new Error(`Metric diagnostic ${mismatch[0]} identity mismatch`);
  if (requireUsable && result.status !== 'completed')
    throw new Error('Metric diagnosis requires completed profiling');
  return result;
}
/** Revalidate the evidence referenced by an immutable metric diagnosis before reuse. */
export async function readMetricsAnalysis(
  ref: string,
  round: number,
  context: RuntimeContext,
): Promise<{
  analysis: MetricsAnalysis;
  parent: Candidate;
  baseline: JsonObject;
  diagnostic: JsonObject;
}> {
  const analysis = parseConfig<MetricsAnalysis>(
    metricsAnalysisSchema,
    await context.artifacts.readJson(ref),
    'Metric analysis',
  );
  if (
    analysis.experimentId !== context.experimentId ||
    analysis.round !== round
  )
    throw new Error('Metric analysis identity mismatch');
  const parent = await readOperatorCandidate(
    analysis.parentCandidateRef,
    context,
  );
  const baseline = await readAssessment(
    analysis.incumbentMeasurementRef,
    parent.ref,
    context,
  );
  if (
    !matchesOperatorSource(
      analysis,
      await readOperatorSource(parent, baseline, context),
    )
  )
    throw new Error('Metric analysis parent source mismatch');
  const diagnostic = await profile(
    analysis.diagnosticMeasurementRef,
    parent,
    baseline,
    context,
  );
  if (analysis.diagnosis !== null)
    parseMetricsDiagnosis(analysis.diagnosis, diagnostic);
  return { analysis, parent, baseline, diagnostic };
}

export async function priorHistory(
  ref: string | null,
  round: number,
  parentRef: string | null,
  context: RuntimeContext,
): Promise<{ history: MetricsHistory; summaries: MetricsSummary[] }> {
  const history: MetricsHistory =
    ref === null
      ? {
          schemaVersion: 'rsi.operator-metrics-history/v1',
          experimentId: context.experimentId,
          summaryRefs: [],
        }
      : parseConfig<MetricsHistory>(
          metricsHistorySchema,
          await context.artifacts.readJson(ref),
          'Metric history',
        );
  if (
    history.experimentId !== context.experimentId ||
    history.summaryRefs.length !== round - 1
  )
    throw new Error('Metric history round or ownership mismatch');
  const summaries: MetricsSummary[] = [];
  for (const item of history.summaryRefs) {
    const stored = parseConfig<MetricsSummary>(
      metricsSummarySchema,
      await context.artifacts.readJson(item),
      'Metric summary',
    );
    assertSummaryEvidence(stored, stored.measurementRefs);
    if (
      stored.experimentId !== context.experimentId ||
      stored.round !== summaries.length + 1 ||
      canonical(stored.facts) !==
        canonical(
          await readAttemptFacts(
            {
              ...stored,
              phase: 'metrics',
              rootCandidateRef: stored.parentCandidateRef,
              baselineMeasurementRef: stored.incumbentMeasurementRef,
              outcome: stored.facts.outcome,
            },
            context,
          ),
        )
    )
      throw new Error('Metric history facts mismatch');
    const { analysis } = await readMetricsAnalysis(
      stored.analysisRef,
      stored.round,
      context,
    );
    if (
      analysis.parentCandidateRef !== stored.parentCandidateRef ||
      analysis.incumbentMeasurementRef !== stored.incumbentMeasurementRef
    )
      throw new Error('Metric history analysis identity mismatch');
    if (
      summaries.length &&
      stored.parentCandidateRef !== summaries.at(-1)!.facts.selectedCandidateRef
    )
      throw new Error('Metric history parent chain mismatch');
    summaries.push(stored);
  }
  if (
    parentRef !== null &&
    summaries.length &&
    parentRef !== summaries.at(-1)!.facts.selectedCandidateRef
  )
    throw new Error('Metric current parent differs from selected history');
  return { history, summaries };
}

export async function readStaticHistory(
  ref: string | null,
  analysisRef: string,
  attempt: number,
  context: RuntimeContext,
): Promise<OperatorHistory | null> {
  if (ref === null) {
    if (attempt !== 1)
      throw new Error('Operator attempt requires the previous history');
    return null;
  }
  const loaded = await readHistory(ref, context);
  if (
    loaded.analysisRef !== analysisRef ||
    loaded.summaries.length !== attempt - 1
  )
    throw new Error('Operator history does not precede this attempt');
  return loaded;
}
