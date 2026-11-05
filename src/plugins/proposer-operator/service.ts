import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type AgentInput,
  type Candidate,
  type JsonObject,
  type JsonValue,
  type OperationDefinition,
  type OperatorProposerInput,
  type OperatorProposerOutput,
  type RuntimeContext,
} from '../../contracts/index.js';
import { parseFileTree } from '../../contracts/models/file-tree.js';
import { validateMeasurement } from '../../contracts/models/measurement.js';
import { applicationContract } from '../../contracts/plugin-types/application.js';
import {
  operatorProposerContract,
  type MetricsOperatorProposerInput,
} from '../../contracts/plugin-types/proposer-operator.js';
import {
  canonical,
  digest,
  object,
  string,
  strings,
} from '../../shared/json.js';
import { parseConfig, validate } from '../../shared/schema.js';
import { applyEdits } from '../shared/agent-editing/index.js';
import { sourceIdentity } from '../shared/evaluator-adapter/identity.js';
import { loadOperatorTask } from '../shared/operator-task.js';
import { readDecisionFeedback } from '../shared/metric-decision/index.js';
import {
  analysisSchema,
  configSchema,
  defaultModelRequestTimeoutMs,
  diagnosisResponseSchema,
  operatorEditConstraints as editConstraints,
  embeddingIdentitySchema,
  historySchema,
  metricsAnalysisSchema,
  metricsBottleneckSchema,
  metricsHistorySchema,
  metricsRetrievalSchema,
  metricsSummarySchema,
  operatorEditOutputSchema,
  staticDiagnosisSchema,
  staticRetrievalSchema,
  summaryResponseSchema,
  summarySchema,
  type AnalysisReceipt,
  type EmbeddingConfig,
  type EmbeddingIdentity,
  type HardwareContext,
  type KnowledgeQuery,
  type KnowledgeResources,
  type MetricsAnalysis,
  type MetricsBottleneck,
  type MetricsHistory,
  type MetricsKnowledgeMatch,
  type MetricsRetrievalResult,
  type MetricsSummary,
  type OperatorAgentStage,
  type OperatorAnalysis,
  type OperatorAnalysisIdentity,
  type OperatorAttempt,
  type OperatorHistory,
  type OperatorHistoryArtifact,
  type OperatorProposerConfig,
  type OperatorResources,
  type OperatorRetrievalResult,
  type OperatorSummary,
  type PreparedAttempt,
  type StaticIssue,
  type StaticKnowledgeMatch,
  type StaticRetrievalResult,
} from './schema.js';

async function readOperatorCandidate(
  ref: string,
  context: RuntimeContext,
): Promise<Candidate> {
  const candidate = await context.readCandidate(ref);
  if (candidate.ref !== ref || candidate.experimentId !== context.experimentId)
    throw new Error('Operator candidate ownership mismatch');
  return candidate;
}

async function readOperatorSource(
  candidate: Candidate,
  context: RuntimeContext,
): Promise<{ source: string; digest: string }> {
  const tree = parseFileTree(
    await context.artifacts.readJson(candidate.artifactRef),
  );
  const file = tree.files.find((item) => item.path === 'input.py');
  if (!file) throw new Error('Operator candidate lacks input.py');
  const bytes = Buffer.from(file.base64, 'base64');
  return {
    source: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function readOperatorMeasurement(
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

async function readOperatorArtifact(
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
async function readAssessment(
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
  const source = await readOperatorSource(candidate, context);
  if (
    measurement.candidateRef !== candidateRef ||
    measurement.status !== 'succeeded' ||
    measurement.finishedAt === null ||
    provenance.mode !== 'sdk' ||
    provenance.cleanup !== 'confirmed' ||
    provenance.artifactRef !== candidate.artifactRef ||
    provenance.sourceDigest !== source.digest
  )
    throw new Error(
      'Operator assessment candidate, source or cleanup mismatch',
    );
  return measurement;
}

function operatorScalar(measurement: JsonObject, name: string): number | null {
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
function assertOperatorConditions(before: JsonObject, after: JsonObject): void {
  for (const field of ['mode', 'taskDigest', 'adapterDigest', 'sdkBuildDigest'])
    if (before[field] !== after[field])
      throw new Error(
        'Operator assessment condition, task or build identity mismatch',
      );
}

/** Derive facts for both new summaries and persisted histories from their owned evidence. */
async function readAttemptFacts(
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
    after < before - before * Number(decision.minRelativeImprovement ?? 0) &&
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
  const source = await readOperatorSource(candidate, context);
  if (source.digest !== identity.sourceDigest)
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

export class OperatorModelOutputError extends Error {}

/** A request and all delegated sessions share Manager-owned accounting. */
export async function requestOperatorAgent(
  stage: OperatorAgentStage,
  request: AgentInput,
  context: RuntimeContext,
  timeoutMs = defaultModelRequestTimeoutMs,
): Promise<JsonObject> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error(
      'Operator modelRequestTimeoutMs must be a positive integer',
    );
  context = context.extend({
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]),
  });
  context.signal.throwIfAborted();
  if (context.scope)
    throw new Error(
      'Operator Agent requests cannot replace an outer budget scope',
    );
  const scope = {
    id: 'operator-' + digest({ callId: context.callId, stage }),
    signal: context.signal,
    limits: {
      modelCalls: 2,
      elapsedWallMs: timeoutMs,
      evidenceBytes: 2 * 1024 * 1024,
    },
  };
  if (Buffer.byteLength(JSON.stringify(request)) > 2 * 1024 * 1024)
    throw new Error(
      'Operator request exceeds 2 MiB; hardware context cannot be truncated',
    );
  let result: JsonObject;
  try {
    result = await context
      .extend({ scope, signal: context.signal })
      .invokeAgent({
        ...request,
        prompt:
          request.prompt +
          '\n\nThe authorized snapshots are already in input.sourceFiles; use them directly without reading the same files again. This stage has two total model calls, including tool continuations and all delegates. Complete the JSON response directly; do not delegate this bounded stage.',
        input: {
          ...object(request.input ?? {}),
          sourceFiles: request.files ?? {},
        },
        maxModelCalls: 2,
      });
  } catch (error) {
    context.signal.throwIfAborted();
    if (
      error instanceof Error &&
      error.message.startsWith(
        'Agent model-call limit reached; last output validation failed:',
      )
    )
      throw new OperatorModelOutputError(error.message, { cause: error });
    throw error;
  }
  context.signal.throwIfAborted();
  try {
    validate(request.outputSchema, result, `Operator ${stage} response`);
  } catch (error) {
    throw new OperatorModelOutputError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  return object(result);
}

/** Validate model data before allocating a mutable workspace; writes enforce these bounds again. */
export function validateOperatorEdits(response: JsonObject): void {
  try {
    validate(operatorEditOutputSchema, response, 'Operator edits');
    const edits = response.edits;
    if (
      Array.isArray(edits) &&
      edits.some(
        (raw) =>
          Buffer.byteLength(String(object(raw).content)) >
          editConstraints.maxChangedBytes,
      )
    )
      throw new Error('Operator edit exceeds byte limit');
  } catch (error) {
    throw new OperatorModelOutputError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

/** Bind every model evidence value to a measured kernel metric, excluding assumed hardware ratios. */
export function parseMetricsBottleneck(
  raw: unknown,
  profile: JsonObject,
): MetricsBottleneck {
  const result = parseConfig<MetricsBottleneck>(
    metricsBottleneckSchema,
    raw,
    'Metric bottleneck',
  );
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

async function sourceText(
  candidate: Candidate,
  context: RuntimeContext,
): Promise<string> {
  return (await readOperatorSource(candidate, context)).source;
}

async function operatorFiles(
  parent: Candidate,
  config: OperatorProposerConfig,
  context: RuntimeContext,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {
    'input.py': await sourceText(parent, context),
  };
  for (const name of ['problem.py', 'test.py', 'task.json'])
    files['context/task/' + name] = await readFile(
      join(config.task.directory, name),
      'utf8',
    );
  return files;
}

async function commitOperatorEdits(
  response: JsonObject,
  parent: Candidate,
  analysisRef: string,
  action: 'propose' | 'repair',
  context: RuntimeContext,
  services: RuntimeContext,
): Promise<OperatorProposerOutput> {
  validateOperatorEdits(response);
  const workspace = await services.workspaces.create(
    parent.artifactRef,
    parent.ref,
  );
  try {
    await applyEdits(workspace.directory, response, context, editConstraints);
    const result = await context.application({
      action: 'commit',
      parentCandidateRef: parent.ref,
      editRef: workspace.ref,
      editConstraints,
    });
    validate(
      applicationContract.output_schema,
      result,
      'Operator candidate commit',
    );
    if (result.action !== 'commit')
      throw new Error('Operator Application did not commit');
    const candidateRef = string(result.candidateRef);
    const rationale = string(response.reason);
    if (result.status === 'created')
      return {
        action,
        status: 'created',
        candidateRef,
        diffRef: string(result.diffRef),
        rationale,
        analysisRef,
        reasonCode: 'created',
      };
    if (
      result.status !== 'no-change' ||
      result.diffRef !== null ||
      candidateRef !== parent.ref
    )
      throw new Error('Invalid operator no-change commit');
    return {
      action,
      status: 'no-change',
      candidateRef,
      diffRef: null,
      rationale,
      analysisRef,
      reasonCode: 'no-supported-change',
    };
  } finally {
    await services.workspaces.release(workspace.ref);
  }
}

async function assertRepair(
  failed: Candidate,
  rootRef: string,
  repairIndex: number,
  baseline: JsonObject,
  measured: JsonObject,
  context: RuntimeContext,
): Promise<void> {
  if (operatorScalar(measured, 'candidateValid') !== 0)
    throw new Error('Operator repair requires a confirmed candidate failure');
  assertOperatorConditions(
    await readOperatorArtifact(baseline, 'conditions', context),
    await readOperatorArtifact(measured, 'conditions', context),
  );
  let cursor = failed;
  for (let depth = 0; depth < repairIndex; depth++) {
    if (cursor.parentRef === null)
      throw new Error('Operator repair ancestry mismatch');
    cursor = await readOperatorCandidate(cursor.parentRef, context);
  }
  if (cursor.ref !== rootRef)
    throw new Error('Operator repair index does not match parent chain');
}

async function proposalFailure(
  input: Extract<OperatorProposerInput, { action: 'propose' | 'repair' }>,
  parentRef: string,
  analysisRef: string,
  error: Error,
  context: RuntimeContext,
): Promise<OperatorProposerOutput> {
  const errorRef = await context.artifacts.putJson({
    schemaVersion: 'rsi.operator-model-error/v1',
    experimentId: context.experimentId,
    phase: input.phase,
    ...(input.phase === 'static'
      ? { attempt: input.attempt }
      : { round: input.round }),
    stage: input.action,
    message: error.message,
  });
  return {
    action: input.action,
    status: 'failed',
    candidateRef: parentRef,
    diffRef: null,
    analysisRef,
    errorRef,
    reasonCode: 'invalid-model-output',
    rationale: error.message,
  };
}

async function summaryExplanation(
  request: AgentInput,
  context: RuntimeContext,
  timeoutMs: number | undefined,
): Promise<
  Pick<
    MetricsSummary,
    | 'summaryStatus'
    | 'explanation'
    | 'lessons'
    | 'avoidPatterns'
    | 'tryPatterns'
  >
> {
  try {
    const response = await requestOperatorAgent(
      'summarize',
      request,
      context,
      timeoutMs,
    );
    return {
      summaryStatus: 'available',
      explanation: string(response.explanation),
      lessons: strings(response.lessons),
      avoidPatterns: strings(response.avoidPatterns),
      tryPatterns: strings(response.tryPatterns),
    };
  } catch (error) {
    if (!(error instanceof OperatorModelOutputError)) throw error;
    return {
      summaryStatus: 'unavailable',
      explanation: `Summary unavailable: ${error.message}`.slice(0, 4000),
      lessons: [],
      avoidPatterns: [],
      tryPatterns: [],
    };
  }
}

function staticFacts(facts: MetricsSummary['facts']): OperatorSummary['facts'] {
  const { outcome, wasTransformCorrect, baselineMs, candidateMs, accepted } =
    facts;
  return { outcome, wasTransformCorrect, baselineMs, candidateMs, accepted };
}

async function storeSummary(
  summary: OperatorSummary | MetricsSummary,
  history: OperatorHistoryArtifact | MetricsHistory,
  context: RuntimeContext,
): Promise<OperatorProposerOutput> {
  context.signal.throwIfAborted();
  validate(
    summary.schemaVersion === 'rsi.operator-summary/v1'
      ? summarySchema
      : metricsSummarySchema,
    summary,
    'Operator summary',
  );
  const summaryRef = await context.artifacts.putJson(summary);
  context.signal.throwIfAborted();
  const historyRef = await context.artifacts.putJson({
    ...history,
    summaryRefs: [...history.summaryRefs, summaryRef],
  });
  context.signal.throwIfAborted();
  return { action: 'summarize', summaryRef, historyRef };
}

async function profile(
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
    source: provenance.sourceDigest === sha(await sourceText(parent, context)),
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
async function priorHistory(
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
    const analysis = parseConfig<MetricsAnalysis>(
      metricsAnalysisSchema,
      await context.artifacts.readJson(stored.analysisRef),
      'Metric history analysis',
    );
    if (
      analysis.experimentId !== context.experimentId ||
      analysis.round !== stored.round ||
      analysis.parentCandidateRef !== stored.parentCandidateRef ||
      analysis.incumbentMeasurementRef !== stored.incumbentMeasurementRef
    )
      throw new Error('Metric history analysis identity mismatch');
    const parent = await readOperatorCandidate(
      analysis.parentCandidateRef,
      context,
    );
    const measured = await readAssessment(
      analysis.incumbentMeasurementRef,
      parent.ref,
      context,
    );
    const diagnostic = await profile(
      analysis.diagnosticMeasurementRef,
      parent,
      measured,
      context,
    );
    if (analysis.sourceDigest !== sha(await sourceText(parent, context)))
      throw new Error('Metric history source mismatch');
    if (analysis.bottleneck !== null)
      parseMetricsBottleneck(analysis.bottleneck, diagnostic);
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

const sha = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
async function saveDiagnostic(
  context: RuntimeContext,
  name: string,
  value: unknown,
): Promise<void> {
  await mkdir(context.directory, { recursive: true });
  await writeFile(
    join(context.directory, name),
    JSON.stringify(value, null, 2) + '\n',
    { flag: 'wx' },
  );
}

export const createOperatorProposer: OperationDefinition<
  OperatorProposerInput,
  OperatorProposerOutput,
  OperatorProposerConfig
>['create'] = async (rawConfig, services) => {
  const config = parseConfig<OperatorProposerConfig>(
    configSchema,
    rawConfig,
    'Operator Proposer config',
  );
  const hardware =
    config.hardwareContextFile === undefined
      ? null
      : await readHardwareContext(config.hardwareContextFile);
  async function baseAnalysis(
    entryRef: string,
    baselineRef: string,
    context: RuntimeContext,
    loaded: OperatorResources,
  ): Promise<OperatorAnalysis> {
    const entry = await readOperatorCandidate(entryRef, context),
      baseline = await readAssessment(baselineRef, entryRef, context);
    const code = await sourceText(entry, context);
    const sourceDigest = sha(Buffer.from(code));
    const conditions = object(
      await context.artifacts.readJson(
        string(object(baseline.conditions).artifactRef),
      ),
    );
    const evaluation = object(conditions.evaluation);
    const task = await loadOperatorTask(config.task.directory);
    if (conditions.taskDigest !== task.taskDigest)
      throw new Error('Operator task differs from baseline measurement');
    const mean = operatorScalar(baseline, 'latencyMeanMs');
    if (mean === null || mean <= 0)
      throw new Error('Operator baseline latency unavailable');
    return {
      schemaVersion: 'rsi.operator-analysis/v1',
      diagnosisComplete: false,
      experimentId: context.experimentId,
      identity: {
        entryCandidateRef: entryRef,
        baselineMeasurementRef: baselineRef,
        sourceDigest,
        comparisonKey: string(baseline.comparisonKey),
        taskDigest: task.taskDigest,
        contractDigest: digest(object(evaluation.contract)),
        environmentDigest: digest(object(evaluation.environment)),
        protocolDigest: digest(object(evaluation.protocol)),
        resourcesDigest: loaded.digest,
        embeddingDigest: sha(await readFile(config.embedding.identityFile)),
        retrievalDigest: digest({
          device: config.embedding.device,
          similarityThreshold: config.embedding.similarityThreshold,
          contextLimit: 20000,
          maxCodeExamples: 3,
        }),
      },
      baselineMs: mean,
      issues: [],
      matches: [],
      knowledgeContext: '',
    };
  }
  async function existingAnalysis(
    ref: string,
    context: RuntimeContext,
    loaded: OperatorResources,
  ): Promise<OperatorAnalysis> {
    const stored = parseConfig<OperatorAnalysis>(
      analysisSchema,
      await context.artifacts.readJson(ref),
      'Operator analysis',
    );
    const current = await baseAnalysis(
      stored.identity.entryCandidateRef,
      stored.identity.baselineMeasurementRef,
      context,
      loaded,
    );
    return readAnalysis(ref, current.identity, context);
  }
  async function history(
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
  async function prepareStatic(
    input: Extract<OperatorProposerInput, { phase: 'static' }>,
    context: RuntimeContext,
    loaded: OperatorResources,
    receipt: AnalysisReceipt,
  ): Promise<PreparedAttempt> {
    let analysis: OperatorAnalysis;
    let analysisRef: string;
    if (input.action === 'propose' && input.analysisRef === null) {
      if (input.attempt !== 1 || input.historyRef !== null)
        throw new Error('Initial operator analysis requires the first attempt');
      const base = await baseAnalysis(
        input.entryCandidateRef,
        input.baselineMeasurementRef,
        context,
        loaded,
      );
      analysisRef = await context.artifacts.putJson(base);
      receipt.analysisRef = analysisRef;
      await readAnalysis(analysisRef, base.identity, context);
      await saveDiagnostic(context, 'analysis-draft.json', {
        analysisRef,
      });
      const entry = await readOperatorCandidate(
        input.entryCandidateRef,
        context,
      );
      const response = await requestOperatorAgent(
        'diagnose',
        {
          agentRef: config.agentRef,
          goal: input.goal,
          prompt: loaded.prompts.diagnose,
          files: await operatorFiles(entry, config, context),
          input: {
            stage: 'diagnose',
            baseline: base,
            task: (await loadOperatorTask(config.task.directory)).definition,
          },
          outputSchema: diagnosisResponseSchema,
        },
        context,
        config.modelRequestTimeoutMs,
      );
      let issues;
      try {
        issues = parseStaticDiagnosis(
          response.issues,
          await sourceText(entry, context),
        );
      } catch (error) {
        throw new OperatorModelOutputError(
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
      }
      analysis = { ...base, diagnosisComplete: true, issues };
      if (issues.length) {
        const retrieved = await retrieveStaticKnowledge(
          issues,
          config.embedding,
          context,
        );
        if (
          retrieved.embeddingDigest !== base.identity.embeddingDigest ||
          retrieved.resourcesDigest !== loaded.knowledgeDigest ||
          retrieved.workerDigest !== loaded.workerDigest
        )
          throw new Error('Operator retrieval identity changed');
        analysis.matches = retrieved.matches;
        analysis.knowledgeContext = retrieved.knowledgeContext;
      }
      analysisRef = await context.artifacts.putJson(analysis);
      receipt.analysisRef = analysisRef;
      await readAnalysis(analysisRef, base.identity, context);
      await saveDiagnostic(context, 'analysis.json', { analysisRef });
    } else {
      if (input.analysisRef === null)
        throw new Error('Operator analysis missing');
      analysisRef = input.analysisRef;
      analysis = await existingAnalysis(analysisRef, context, loaded);
    }
    const identity = analysis.identity;
    if (
      input.action === 'propose' &&
      (identity.entryCandidateRef !== input.entryCandidateRef ||
        identity.baselineMeasurementRef !== input.baselineMeasurementRef)
    )
      throw new Error('Operator proposal entry identity mismatch');
    if (
      input.action === 'summarize' &&
      input.entryCandidateRef !== identity.entryCandidateRef
    )
      throw new Error('Operator summary entry mismatch');
    const prior = await history(
      input.historyRef,
      analysisRef,
      input.attempt,
      context,
    );
    if (input.action === 'propose' && analysis.diagnosisComplete === false)
      throw new OperatorModelOutputError(
        'Static diagnosis did not produce a valid result; no empty-diagnosis claim is available',
      );
    return {
      parent: await readOperatorCandidate(identity.entryCandidateRef, context),
      baseline: await readAssessment(
        identity.baselineMeasurementRef,
        identity.entryCandidateRef,
        context,
      ),
      analysisRef,
      historyArtifact: {
        schemaVersion: 'rsi.operator-history/v1',
        experimentId: context.experimentId,
        analysisRef,
        summaryRefs: prior?.summaryRefs ?? [],
      },
      generationContext: {
        analysis,
        history: (prior?.summaries ?? []).slice(-(config.historyWindow ?? 5)),
        hardwareContext: hardware?.text ?? null,
      },
      summaryContext: { analysis, history: prior?.summaries ?? [] },
      generatePrompt: loaded.prompts.generate,
      techniqueIds: [
        ...new Set(analysis.issues.map((issue) => issue.issue_type)),
      ],
      noStaticIssues: !analysis.issues.length,
    };
  }

  async function prepareMetrics(
    input: MetricsOperatorProposerInput,
    context: RuntimeContext,
    loaded: OperatorResources,
    receipt: AnalysisReceipt,
  ): Promise<PreparedAttempt> {
    let analysis: MetricsAnalysis;
    let analysisRef: string;
    let parent: Candidate;
    let baseline: JsonObject;
    let diagnostic: JsonObject;
    if (input.action === 'propose') {
      parent = await readOperatorCandidate(input.parentCandidateRef, context);
      baseline = await readAssessment(
        input.incumbentMeasurementRef,
        parent.ref,
        context,
      );
      if (operatorScalar(baseline, 'candidateValid') !== 1)
        throw new Error('Metric optimization requires a valid incumbent');
      const task = await loadOperatorTask(config.task.directory);
      if (
        (await readOperatorArtifact(baseline, 'conditions', context))
          .taskDigest !== task.taskDigest
      )
        throw new Error('Metric task identity mismatch');
      diagnostic = await profile(
        input.diagnosticMeasurementRef,
        parent,
        baseline,
        context,
      );
      analysis = {
        schemaVersion: 'rsi.operator-metrics-analysis/v1',
        experimentId: context.experimentId,
        round: input.round,
        parentCandidateRef: parent.ref,
        incumbentMeasurementRef: input.incumbentMeasurementRef,
        diagnosticMeasurementRef: input.diagnosticMeasurementRef,
        sourceDigest: sha(await sourceText(parent, context)),
        resourcesDigest: loaded.digest,
        embeddingDigest: sha(await readFile(config.embedding.identityFile)),
        hardwareDigest: hardware?.sha256 ?? null,
        bottleneck: null,
        knowledgeContext: '',
        retrievalRef: null,
        retrievalStatus: 'skipped',
      };
      analysisRef = await context.artifacts.putJson(analysis);
      receipt.analysisRef = analysisRef;
    } else {
      analysisRef = input.analysisRef;
      analysis = parseConfig<MetricsAnalysis>(
        metricsAnalysisSchema,
        await context.artifacts.readJson(analysisRef),
        'Metric analysis',
      );
      if (
        analysis.experimentId !== context.experimentId ||
        analysis.round !== input.round ||
        analysis.resourcesDigest !== loaded.digest ||
        analysis.embeddingDigest !==
          sha(await readFile(config.embedding.identityFile)) ||
        analysis.hardwareDigest !== (hardware?.sha256 ?? null)
      )
        throw new Error('Metric analysis identity mismatch');
      parent = await readOperatorCandidate(
        analysis.parentCandidateRef,
        context,
      );
      baseline = await readAssessment(
        analysis.incumbentMeasurementRef,
        parent.ref,
        context,
      );
      if (analysis.sourceDigest !== sha(await sourceText(parent, context)))
        throw new Error('Metric analysis parent source mismatch');
      diagnostic = await profile(
        analysis.diagnosticMeasurementRef,
        parent,
        baseline,
        context,
      );
    }
    const prior = await priorHistory(
      input.historyRef,
      input.round,
      parent.ref,
      context,
    );
    const staticHistory =
      input.staticHistoryRef === null
        ? null
        : await readHistory(input.staticHistoryRef, context);
    const metricContext = {
      phase: 'metrics',
      profile: diagnostic,
      history: prior.summaries.slice(-(config.historyWindow ?? 5)),
      staticHistory: staticHistory?.summaries ?? [],
    };
    if (input.action === 'propose') {
      const response = await requestOperatorAgent(
        'diagnose-metrics',
        {
          agentRef: config.agentRef,
          goal: input.goal,
          prompt: loaded.prompts['diagnose-metrics'],
          files: await operatorFiles(parent, config, context),
          input: {
            stage: 'diagnose-metrics',
            profile: diagnostic,
            history: metricContext.history,
            staticHistory: metricContext.staticHistory,
            hardwareContext: hardware?.text ?? null,
          },
          outputSchema: metricsBottleneckSchema,
        },
        context,
        config.modelRequestTimeoutMs,
      );
      try {
        analysis.bottleneck = parseMetricsBottleneck(response, diagnostic);
      } catch (error) {
        throw new OperatorModelOutputError(
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
      }
      const bottleneck = analysis.bottleneck;
      try {
        const retrieved = await retrieveMetricsKnowledge(
          `${bottleneck.category}: ${bottleneck.summary} ${bottleneck.recommendedFix}`,
          config.embedding,
          context,
        );
        if (
          retrieved.resourcesDigest !== loaded.knowledgeDigest ||
          retrieved.workerDigest !== loaded.workerDigest ||
          retrieved.embeddingDigest !== analysis.embeddingDigest
        )
          throw new Error('Metric retrieval resource identity changed');
        analysis.retrievalRef = await context.artifacts.putJson(retrieved);
        analysis.knowledgeContext = retrieved.knowledgeContext;
        analysis.retrievalStatus = 'available';
      } catch (error) {
        if (!(error instanceof MetricsRetrievalUnavailable)) throw error;
        analysis.retrievalRef = await context.artifacts.putJson({
          status: 'unavailable',
          reason: error.message,
        });
        analysis.retrievalStatus = 'unavailable';
      }
      analysisRef = await context.artifacts.putJson(analysis);
      receipt.analysisRef = analysisRef;
    }
    if (input.action === 'repair' && analysis.bottleneck === null)
      throw new Error('Metric repair requires a completed analysis');
    if (
      input.action === 'summarize' &&
      (input.parentCandidateRef !== parent.ref ||
        input.incumbentMeasurementRef !== baseline.ref)
    )
      throw new Error('Metric summary parent mismatch');
    return {
      parent,
      baseline,
      analysisRef,
      historyArtifact: prior.history,
      generationContext: {
        phase: 'metrics',
        analysis,
        profile: diagnostic,
        history: metricContext.history,
        staticHistory: metricContext.staticHistory,
        hardwareContext: hardware?.text ?? null,
      },
      summaryContext: {
        phase: 'metrics',
        analysis,
        profile: diagnostic,
        history: metricContext.history,
        staticHistory: metricContext.staticHistory,
      },
      generatePrompt: loaded.metricsGenerate,
      techniqueIds: [],
      noStaticIssues: false,
    };
  }

  async function summarize(
    input: Extract<OperatorProposerInput, { action: 'summarize' }>,
    prepared: PreparedAttempt,
    loaded: OperatorResources,
    context: RuntimeContext,
  ): Promise<OperatorProposerOutput> {
    const facts = await readAttemptFacts(
      {
        ...input,
        rootCandidateRef: prepared.parent.ref,
        baselineMeasurementRef: string(prepared.baseline.ref),
      },
      context,
    );
    const receipts = (await context.facts.list('calls')).filter(
      (call) =>
        call.experimentId === context.experimentId &&
        call.pluginId === 'proposer.operator' &&
        call.status === 'succeeded',
    );
    let actionSummary: string;
    let summaryInput: JsonObject;
    if (input.phase === 'static') {
      const rationale = receipts
        .filter(
          (call) =>
            object(call.input).attempt === input.attempt &&
            input.candidateRefs.includes(
              String(object(call.output).candidateRef),
            ),
        )
        .sort(
          (a, b) =>
            Number(object(a.input).repairIndex ?? 0) -
            Number(object(b.input).repairIndex ?? 0),
        )
        .map((call) => String(object(call.output).rationale ?? ''))
        .join('\n');
      actionSummary =
        rationale.length > 4000
          ? rationale.slice(0, 3900) +
            '\n[Truncated; full rationale remains in successful call receipts.]'
          : rationale;
      summaryInput = {
        stage: 'summarize',
        ...prepared.summaryContext,
        facts: staticFacts(facts),
        actionSummary,
        candidateRefs: input.candidateRefs,
        measurementRefs: input.measurementRefs,
        decisionRef: input.decisionRef,
      };
    } else {
      const actions = receipts
        .filter(
          (call) =>
            object(call.input).phase === 'metrics' &&
            object(call.input).round === input.round &&
            ['propose', 'repair'].includes(String(object(call.input).action)),
        )
        .map((call) => ({
          action: object(call.input).action,
          status: object(call.output).status,
          candidateRef: object(call.output).candidateRef,
          rationale: object(call.output).rationale ?? '',
          errorRef: object(call.output).errorRef ?? null,
        }));
      actionSummary = actions
        .map(
          (action) => `${action.action}: ${action.status}; ${action.rationale}`,
        )
        .join('\n')
        .slice(0, 4000);
      let candidateProfile: JsonObject | null = null;
      if (input.candidateDiagnosticMeasurementRef !== null) {
        if (!facts.accepted)
          throw new Error(
            'Non-promoted metric candidate cannot claim new diagnostics',
          );
        const selected = await readOperatorCandidate(
          facts.selectedCandidateRef,
          context,
        );
        candidateProfile = await profile(
          input.candidateDiagnosticMeasurementRef,
          selected,
          await readAssessment(
            input.measurementRefs.at(-1)!,
            selected.ref,
            context,
          ),
          context,
          false,
        );
      }
      summaryInput = {
        stage: 'summarize',
        ...prepared.summaryContext,
        candidateProfile,
        actions,
        evidence: input.measurementRefs.length
          ? await context.readEvidence(input.measurementRefs, {
              view: 'training-summary',
            })
          : null,
        facts,
      };
    }
    const content = {
      experimentId: context.experimentId,
      analysisRef: prepared.analysisRef,
      candidateRefs: input.candidateRefs,
      measurementRefs: input.measurementRefs,
      decisionRef: input.decisionRef,
      actionSummary,
      ...(await summaryExplanation(
        {
          agentRef: config.agentRef,
          goal:
            input.phase === 'static'
              ? 'Summarize this completed operator optimization attempt using the confirmed facts.'
              : 'Summarize the confirmed metric optimization attempt; causes remain hypotheses.',
          prompt: loaded.prompts.summarize,
          files: await operatorFiles(
            await readOperatorCandidate(
              input.candidateRefs.at(-1) ?? prepared.parent.ref,
              context,
            ),
            config,
            context,
          ),
          input: summaryInput,
          outputSchema: summaryResponseSchema,
        },
        context,
        config.modelRequestTimeoutMs,
      )),
    };
    const draft: OperatorSummary | MetricsSummary =
      input.phase === 'static'
        ? {
            ...content,
            schemaVersion: 'rsi.operator-summary/v1',
            attempt: input.attempt,
            techniqueIds: prepared.techniqueIds,
            facts: staticFacts(facts),
          }
        : {
            ...content,
            schemaVersion: 'rsi.operator-metrics-summary/v1',
            round: input.round,
            parentCandidateRef: prepared.parent.ref,
            incumbentMeasurementRef: input.incumbentMeasurementRef,
            candidateDiagnosticMeasurementRef:
              input.candidateDiagnosticMeasurementRef,
            facts,
          };
    return storeSummary(draft, prepared.historyArtifact, context);
  }

  return {
    async execute(input, context) {
      validate(
        operatorProposerContract.input_schema,
        input,
        'Operator Proposer input',
      );
      context.signal.throwIfAborted();
      const loaded = await loadOperatorResources(config);
      const receipt: AnalysisReceipt = {
        analysisRef:
          input.action === 'propose' && input.phase === 'metrics'
            ? null
            : input.analysisRef,
      };
      try {
        const prepared =
          input.phase === 'static'
            ? await prepareStatic(input, context, loaded, receipt)
            : await prepareMetrics(input, context, loaded, receipt);
        if (input.action === 'summarize')
          return await summarize(input, prepared, loaded, context);
        if (input.action === 'propose' && prepared.noStaticIssues)
          return {
            action: 'propose',
            status: 'no-change',
            candidateRef: prepared.parent.ref,
            diffRef: null,
            rationale: 'No supported static issues were diagnosed.',
            analysisRef: prepared.analysisRef,
            reasonCode: 'no-static-issues',
          };
        let parent = prepared.parent;
        if (input.action === 'repair') {
          parent = await readOperatorCandidate(
            input.failedCandidateRef,
            context,
          );
          await assertRepair(
            parent,
            prepared.parent.ref,
            input.repairIndex,
            prepared.baseline,
            await readAssessment(input.measurementRef, parent.ref, context),
            context,
          );
        }
        const stage = input.action === 'propose' ? 'generate' : 'repair';
        const response = await requestOperatorAgent(
          stage,
          {
            agentRef: config.agentRef,
            goal: input.goal,
            prompt:
              (stage === 'generate'
                ? prepared.generatePrompt
                : loaded.prompts.repair) +
              '\n\n' +
              loaded.guidelines,
            files: await operatorFiles(parent, config, context),
            input: {
              stage,
              ...prepared.generationContext,
              evidence:
                input.action === 'repair'
                  ? await context.readEvidence([input.measurementRef], {
                      view: 'training-summary',
                    })
                  : null,
              target: (await context.applicationMetadata()).target ?? null,
              editConstraints,
            },
            outputSchema: operatorEditOutputSchema,
          },
          context,
          config.modelRequestTimeoutMs,
        );
        return await commitOperatorEdits(
          response,
          parent,
          prepared.analysisRef,
          input.action,
          context,
          services,
        );
      } catch (error) {
        if (
          !(error instanceof OperatorModelOutputError) ||
          input.action === 'summarize' ||
          receipt.analysisRef === null
        )
          throw error;
        return proposalFailure(
          input,
          input.action === 'repair'
            ? input.failedCandidateRef
            : input.phase === 'static'
              ? input.entryCandidateRef
              : input.parentCandidateRef,
          receipt.analysisRef,
          error,
          context,
        );
      }
    },
    async dispose() {},
  };
};

const maxRetrievalBytes = 2 * 1024 * 1024;
const maxLogBytes = 65536;

function safeRelativeResource(path: string): string {
  if (
    isAbsolute(path) ||
    path.includes('\\') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid operator resource identity relative file path');
  return path;
}
async function readRetrievalJson(path: string): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxRetrievalBytes)
    throw new Error('Retrieval JSON must be an ordinary file of at most 2 MiB');
  return readFile(path);
}
async function fileDigest(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal }))
    hash.update(chunk);
  return hash.digest('hex');
}
export async function readKnowledgeResources(
  config: Pick<EmbeddingConfig, 'resourcesDirectory' | 'retrievalScript'>,
): Promise<KnowledgeResources> {
  const directory = await realpath(config.resourcesDirectory);
  const manifestPath = join(directory, 'knowledge/manifest.json');
  const manifestLocal = relative(directory, await realpath(manifestPath));
  if (isAbsolute(manifestLocal) || manifestLocal.startsWith('..' + sep))
    throw new Error(
      'Knowledge manifest must be an ordinary file inside its directory',
    );
  const bytes = await readRetrievalJson(manifestPath);
  const manifest = object(JSON.parse(bytes.toString('utf8')));
  if (
    manifest.schemaVersion !== 'rsi.operator-knowledge/v1' ||
    !Array.isArray(manifest.resources) ||
    !Array.isArray(manifest.techniques) ||
    !Array.isArray(manifest.metrics)
  )
    throw new Error('Invalid external operator knowledge manifest');
  const resources = new Map<string, string>();
  let guidelines = '';
  for (const raw of manifest.resources) {
    const entry = object(raw);
    const path = safeRelativeResource(string(entry.path));
    if (resources.has(path))
      throw new Error('Duplicate external knowledge resource path');
    const resolved = await realpath(resolve(directory, path));
    const local = relative(directory, resolved);
    if (
      isAbsolute(local) ||
      local === '..' ||
      local.startsWith('..' + sep) ||
      !(await lstat(resolve(directory, path))).isFile()
    )
      throw new Error('Knowledge resource escapes its directory');
    const content = await readFile(resolved);
    if (sha(content) !== entry.sha256)
      throw new Error(`Knowledge resource changed: ${path}`);
    resources.set(path, string(entry.sha256));
    if (path === manifest.guidelines)
      guidelines = new TextDecoder('utf-8', { fatal: true }).decode(content);
  }
  if (
    manifest.guidelines !== undefined &&
    !resources.has(string(manifest.guidelines))
  )
    throw new Error(
      'Knowledge guidelines must reference an inventoried resource',
    );
  const worker = await lstat(config.retrievalScript);
  if (!worker.isFile() || worker.isSymbolicLink())
    throw new Error('Retrieval script must be an ordinary file');
  return {
    manifest,
    resources,
    digest: sha(bytes),
    workerDigest: await fileDigest(config.retrievalScript),
    guidelines,
  };
}

/** Verify the exact deployed model inventory before invoking its CPU worker. */
export async function readEmbeddingIdentity(
  config: Pick<EmbeddingConfig, 'modelDirectory' | 'identityFile'>,
  signal?: AbortSignal,
): Promise<{ identity: EmbeddingIdentity; digest: string }> {
  signal?.throwIfAborted();
  const bytes = await readRetrievalJson(config.identityFile);
  const identity = parseConfig<EmbeddingIdentity>(
    embeddingIdentitySchema,
    JSON.parse(bytes.toString('utf8')),
    'Embedding identity',
  );
  const directory = resolve(config.modelDirectory);
  const excluded = resolve(config.identityFile);
  if (!(await lstat(directory)).isDirectory())
    throw new Error('Embedding model directory must be an ordinary directory');
  const found: { path: string; sha256: string }[] = [];
  async function visit(current: string): Promise<void> {
    for (const name of (await readdir(current)).sort()) {
      signal?.throwIfAborted();
      const path = join(current, name);
      if (resolve(path) === excluded) continue;
      const stat = await lstat(path);
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) {
        found.push({
          path: relative(directory, path).split(sep).join('/'),
          sha256: await fileDigest(path, signal),
        });
        if (found.length > 10000)
          throw new Error('Embedding model identity exceeds 10000 files');
      } else
        throw new Error(
          'Embedding model identity rejects symlinks and nonordinary files',
        );
    }
  }
  const expected = identity.files.map((file) => ({
    ...file,
    path: safeRelativeResource(file.path),
  }));
  await visit(directory);
  expected.sort((a, b) => a.path.localeCompare(b.path));
  found.sort((a, b) => a.path.localeCompare(b.path));
  if (canonical(expected) !== canonical(found))
    throw new Error('Embedding model file identity mismatch');
  return { identity, digest: sha(bytes) };
}
async function groupHasLiveProcesses(pid: number): Promise<boolean> {
  if (process.platform === 'linux') {
    for (const id of await readdir('/proc')) {
      if (!/^\d+$/.test(id)) continue;
      try {
        const raw = await readFile(`/proc/${id}/stat`, 'utf8');
        const parts = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
        if (Number(parts[2]) === pid && !['Z', 'X'].includes(parts[0]!))
          return true;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            ['ENOENT', 'ESRCH', 'EACCES'].includes(String(error.code))
          )
        )
          throw error;
      }
    }
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
      return false;
    throw error;
  }
}
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
      throw error;
  }
}
async function runWorker(
  config: EmbeddingConfig,
  args: string[],
  cwd: string,
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (process.platform === 'win32')
    throw new Error('Operator retrieval requires POSIX process-group cleanup');
  let stdout = Buffer.alloc(0),
    stderr = Buffer.alloc(0),
    failure: Error | undefined;
  const child = spawn(config.python, args, {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CUDA_VISIBLE_DEVICES: '',
      ASCEND_RT_VISIBLE_DEVICES: '',
      HIP_VISIBLE_DEVICES: '',
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HF_HOME: join(cwd, 'hf-cache'),
      OMP_NUM_THREADS: '4',
      MKL_NUM_THREADS: '4',
      TOKENIZERS_PARALLELISM: 'false',
    },
  });
  const stop = (error: Error): void => {
    failure ??= error;
    try {
      killGroup(child.pid);
    } catch (killError) {
      failure = new Error('Retrieval worker cleanup failed', {
        cause: killError,
      });
    }
  };
  const abort = (): void =>
    stop(
      signal.reason instanceof Error
        ? signal.reason
        : new Error('Retrieval worker cancelled'),
    );
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(
    () => stop(new Error('Retrieval worker timeout')),
    config.timeoutMs,
  );
  child.stdout.on('data', (chunk: Buffer) => {
    if (stdout.length + chunk.length > maxLogBytes)
      stop(new Error('Retrieval worker output log exceeds 64 KiB'));
    else stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length + chunk.length > maxLogBytes)
      stop(new Error('Retrieval worker error log exceeds 64 KiB'));
    else stderr = Buffer.concat([stderr, chunk]);
  });
  let code: number | null = null;
  try {
    code = await new Promise<number | null>((resolve) => {
      child.once('error', (error) => {
        failure ??= error;
      });
      child.once('close', resolve);
    });
    killGroup(child.pid);
    let live =
      child.pid !== undefined && (await groupHasLiveProcesses(child.pid));
    for (let attempt = 0; live && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      live = await groupHasLiveProcesses(child.pid!);
    }
    await writeFile(
      join(directory, 'process.json'),
      JSON.stringify({
        pid: child.pid ?? null,
        exitCode: code,
        cleanup: live ? 'unknown' : 'confirmed',
        error: failure?.message ?? null,
      }) + '\n',
    );
    await writeFile(join(directory, 'stdout.log'), stdout);
    await writeFile(join(directory, 'stderr.log'), stderr);
    if (live) throw new Error('Retrieval worker cleanup unknown');
    if (failure) throw failure;
    if (code !== 0)
      throw new Error(
        `Retrieval worker exited ${code}: ${stderr.toString('utf8').trim()}`,
      );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export class MetricsRetrievalUnavailable extends Error {}

/** Static and measured bottleneck queries share one bounded retrieval protocol. */
async function retrieveKnowledge<Match extends MetricsKnowledgeMatch>(
  query: KnowledgeQuery,
  schema: JsonObject,
  config: EmbeddingConfig,
  context: RuntimeContext,
): Promise<OperatorRetrievalResult<Match>> {
  context.signal.throwIfAborted();
  if (
    config.device !== 'cpu' ||
    !Number.isFinite(config.similarityThreshold) ||
    config.similarityThreshold < 0 ||
    config.similarityThreshold > 1 ||
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs <= 0
  )
    throw new Error('Invalid CPU retrieval configuration');
  const { identity, digest: embeddingDigest } = await readEmbeddingIdentity(
    config,
    context.signal,
  );
  const bundle = await readKnowledgeResources(config);
  const rawTechniques =
    'issues' in query ? bundle.manifest.techniques : bundle.manifest.metrics;
  if (!Array.isArray(rawTechniques))
    throw new Error('Knowledge techniques must be an array');
  const techniques = rawTechniques.map((entry) => object(entry));
  const directory = join(context.directory, 'retrieval');
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), 'rsi-operator-retrieval-'));
  try {
    const request = {
      schemaVersion: 'rsi.operator-retrieval-request/v1',
      ...query,
      modelDirectory: resolve(config.modelDirectory),
      identityFile: resolve(config.identityFile),
      embeddingDigest,
      resourcesDirectory: resolve(config.resourcesDirectory),
      resourcesDigest: bundle.digest,
      device: 'cpu',
      similarityThreshold: config.similarityThreshold,
    };
    const requestPath = join(directory, 'request.json');
    const responsePath = join(temporary, 'response.json');
    const body = Buffer.from(JSON.stringify(request) + '\n');
    if (body.length > maxRetrievalBytes)
      throw new Error('Retrieval worker request exceeds 2 MiB');
    await writeFile(requestPath, body, { flag: 'wx', mode: 0o600 });
    try {
      await runWorker(
        config,
        [
          resolve(config.retrievalScript),
          '--request',
          requestPath,
          '--response',
          responsePath,
        ],
        temporary,
        directory,
        context.signal,
      );
    } catch (error) {
      context.signal.throwIfAborted();
      if ('issues' in query) throw error;
      const outcome = object(
        JSON.parse(await readFile(join(directory, 'process.json'), 'utf8')),
      );
      if (outcome.cleanup !== 'confirmed') throw error;
      throw new MetricsRetrievalUnavailable(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    const bytes = await readRetrievalJson(responsePath);
    await writeFile(join(directory, 'response.json'), bytes, { flag: 'wx' });
    const raw = parseConfig<
      Omit<OperatorRetrievalResult<Match>, 'workerDigest'>
    >(schema, JSON.parse(bytes.toString('utf8')), 'Retrieval worker result');
    if ((await fileDigest(config.retrievalScript)) !== bundle.workerDigest)
      throw new Error('Retrieval script changed during execution');
    const result = { ...raw, workerDigest: bundle.workerDigest };
    if (
      result.embeddingDigest !== embeddingDigest ||
      result.resourcesDigest !== bundle.digest ||
      canonical(result.model) !== canonical(identity.model)
    )
      throw new Error('Retrieval worker identity mismatch');
    const seen = new Set<string>();
    for (const match of result.matches) {
      const technique = techniques.find(
        (entry) => entry.id === match.techniqueId,
      );
      if (
        !technique ||
        seen.has(match.techniqueId) ||
        match.score < config.similarityThreshold ||
        ('issues' in query &&
          match.issueIndexes.some(
            (index) => query.issues[index]?.issue_type !== match.techniqueId,
          )) ||
        bundle.resources.get(string(technique.document)) !==
          match.documentDigest ||
        (technique.example === null
          ? match.exampleDigest !== null
          : bundle.resources.get(string(technique.example)) !==
            match.exampleDigest)
      )
        throw new Error('Retrieval worker match identity or coverage mismatch');
      seen.add(match.techniqueId);
    }
    if (!result.matches.length && result.knowledgeContext !== '')
      throw new Error('Retrieval worker invented unmatched knowledge context');
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify(result, null, 2) + '\n',
      { flag: 'wx' },
    );
    context.signal.throwIfAborted();
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function retrieveStaticKnowledge(
  issues: StaticIssue[],
  config: EmbeddingConfig,
  context: RuntimeContext,
): Promise<StaticRetrievalResult> {
  context.signal.throwIfAborted();
  validate(staticDiagnosisSchema, issues, 'Retrieval issues');
  if (!issues.length)
    throw new Error('Retrieval requires at least one static issue');
  return retrieveKnowledge<StaticKnowledgeMatch>(
    { issues },
    staticRetrievalSchema,
    config,
    context,
  );
}
export async function retrieveMetricsKnowledge(
  query: string,
  config: EmbeddingConfig,
  context: RuntimeContext,
): Promise<MetricsRetrievalResult> {
  if (!query.trim() || query.length > 16000)
    throw new Error('Invalid metric retrieval query');
  return retrieveKnowledge<MetricsKnowledgeMatch>(
    { mode: 'metrics', query },
    metricsRetrievalSchema,
    config,
    context,
  );
}

/** Read the full user document without supplying implicit hardware defaults. */
export async function readHardwareContext(
  path: string,
): Promise<HardwareContext> {
  if (typeof path !== 'string' || path.trim() === '')
    throw new Error('hardwareContextFile must be a nonempty file path');
  let bytes: Buffer;
  try {
    const stat = await lstat(path);
    if (!stat.isFile())
      throw new Error('expected an ordinary file without symlinks');
    if ((stat.mode & 0o444) === 0) throw new Error('file is not readable');
    bytes = await readFile(path);
  } catch (error) {
    throw new Error(
      `hardwareContextFile could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (error) {
    throw new Error('hardwareContextFile must contain valid UTF-8 text', {
      cause: error,
    });
  }
  if (text.trim() === '')
    throw new Error('hardwareContextFile must not be empty');
  return { text, sha256: sha(bytes) };
}
export async function loadOperatorResources(
  config: OperatorProposerConfig,
): Promise<OperatorResources> {
  const external = await readKnowledgeResources(config.embedding);
  const contents: Record<string, string> = {};
  for (const name of [
    'diagnose',
    'diagnose-metrics',
    'generate',
    'generate-metrics',
    'repair',
    'summarize',
  ]) {
    const path = join(config.promptsDirectory, `${name}.md`);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      throw new Error(`promptsDirectory: cannot read ${name}.md at ${path}`, {
        cause: error,
      });
    }
    if (!content.trim())
      throw new Error(`promptsDirectory: ${name}.md must not be empty`);
    contents[name] = content;
  }
  const get = (name: string): string => string(contents[name]);
  return {
    digest: digest({
      prompts: contents,
      knowledge: external.digest,
      worker: external.workerDigest,
      taskModel: await sourceIdentity(import.meta.url, [
        '../shared/operator-task',
      ]),
    }),
    knowledgeDigest: external.digest,
    workerDigest: external.workerDigest,
    prompts: {
      diagnose: get('diagnose'),
      'diagnose-metrics': get('diagnose-metrics'),
      generate: get('generate'),
      repair: get('repair'),
      summarize: get('summarize'),
    },
    metricsGenerate: get('generate-metrics'),
    guidelines: external.guidelines,
  };
}
