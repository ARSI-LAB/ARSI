import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  Candidate,
  JsonObject,
  OperatorProposerOutput,
  RuntimeContext,
} from '../../contracts/index.js';
import type { MetricsOperatorProposerInput } from '../../contracts/plugin-types/proposer-operator.js';
import { applicationContract } from '../../contracts/plugin-types/application.js';
import { validateMeasurement } from '../../contracts/models/measurement.js';
import { canonical, object, string, strings } from '../../shared/json.js';
import { parseConfig, validate } from '../../shared/schema.js';
import { applyEdits, resourceFiles } from '../shared/agent-editing/index.js';
import {
  metricDecisionSchema,
  readDecisionFeedback,
} from '../shared/metric-decision/index.js';
import { loadOperatorTask } from '../evaluator-operatorbench/task.js';
import { readHistory } from './context.js';
import { parseMetricsBottleneck } from './metrics-analysis.js';
import {
  OperatorModelOutputError,
  requestOperatorAgent,
  type OperatorAgentStage,
} from './agent.js';
import {
  retrieveMetricsKnowledge,
  MetricsRetrievalUnavailable,
} from './retrieval.js';
import {
  metricsAnalysisSchema,
  metricsBottleneckSchema,
  metricsHistorySchema,
  metricsSummarySchema,
  summaryResponseSchema,
  type MetricsAnalysis,
  type MetricsHistory,
  type MetricsSummary,
  type OperatorProposerConfig,
} from './schema.js';
import {
  operatorEditConstraints as editConstraints,
  operatorEditOutputSchema,
  validateOperatorEdits,
} from './editing.js';
import type { HardwareContext } from './hardware-context.js';

export type OperatorResources = {
  digest: string;
  prompts: Record<OperatorAgentStage, string>;
  metricsGenerate: string;
  guidelines: string;
};
const hash = (text: string | Buffer): string =>
  createHash('sha256').update(text).digest('hex');
async function candidate(
  ref: string,
  context: RuntimeContext,
): Promise<Candidate> {
  const value = await context.readCandidate(ref);
  if (value.experimentId !== context.experimentId || value.ref !== ref)
    throw new Error('Metric candidate ownership mismatch');
  return value;
}
async function code(
  value: Candidate,
  context: RuntimeContext,
): Promise<string> {
  return string((await resourceFiles(value.artifactRef, context))['input.py']);
}
async function artifact(
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
async function assessment(
  ref: string,
  expected: string,
  context: RuntimeContext,
): Promise<JsonObject> {
  const value = await context.readMeasurement(ref);
  validateMeasurement(value);
  const entry = await candidate(expected, context);
  const provenance = await artifact(value, 'provenance', context);
  if (
    value.ref !== ref ||
    value.experimentId !== context.experimentId ||
    value.candidateRef !== expected ||
    value.status !== 'succeeded' ||
    value.finishedAt === null ||
    object(value.evaluator).pluginId !== 'evaluator.operatorbench' ||
    provenance.cleanup !== 'confirmed' ||
    provenance.artifactRef !== entry.artifactRef ||
    provenance.sourceDigest !== hash(await code(entry, context))
  )
    throw new Error('Metric assessment ownership, source or cleanup mismatch');
  return value;
}
function scalar(value: JsonObject, name: string): number | null {
  const metric = object(object(value.metrics)[name]);
  if (metric.status === 'unavailable') return null;
  const raw = object(metric.value);
  if (
    metric.status !== 'available' ||
    raw.kind !== 'scalar' ||
    typeof raw.value !== 'number' ||
    !Number.isFinite(raw.value)
  )
    throw new Error(`Metric assessment ${name} unavailable`);
  return raw.value;
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
  const provenance = await artifact(measurement, 'provenance', context);
  const conditions = await artifact(measurement, 'conditions', context);
  const expected = await artifact(incumbent, 'conditions', context);
  const details = await artifact(measurement, 'profile', context);
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
    source: provenance.sourceDigest === hash(await code(parent, context)),
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
async function files(
  parent: Candidate,
  config: OperatorProposerConfig,
  context: RuntimeContext,
): Promise<Record<string, string>> {
  const result = { 'input.py': await code(parent, context) };
  for (const name of ['problem.py', 'test.py', 'task.json'])
    Object.assign(result, {
      ['context/task/' + name]: await readFile(
        join(config.task.directory, name),
        'utf8',
      ),
    });
  return result;
}
async function facts(
  summary: MetricsSummary,
  context: RuntimeContext,
): Promise<MetricsSummary['facts']> {
  const incumbent = await assessment(
    summary.incumbentMeasurementRef,
    summary.parentCandidateRef,
    context,
  );
  if (scalar(incumbent, 'candidateValid') !== 1)
    throw new Error('Metric incumbent must be correct');
  const before = scalar(incumbent, 'latencyMeanMs');
  if (before === null || before <= 0)
    throw new Error('Metric incumbent latency missing');
  let correct: boolean | null = null,
    after: number | null = null,
    accepted = false;
  if (!summary.measurementRefs.length) {
    if (
      !['no-change', 'proposal-failed'].includes(summary.facts.outcome) ||
      summary.decisionRef !== null
    )
      throw new Error('Unmeasured metric attempt cannot claim an outcome');
    if (summary.candidateRefs.some((ref) => ref !== summary.parentCandidateRef))
      throw new Error('Unmeasured metric attempt candidate mismatch');
  } else {
    if (summary.candidateRefs.length !== summary.measurementRefs.length)
      throw new Error('Metric candidate assessment coverage mismatch');
    let parent = summary.parentCandidateRef;
    const beforeConditions = await artifact(incumbent, 'conditions', context);
    for (let i = 0; i < summary.candidateRefs.length; i++) {
      const ref = summary.candidateRefs[i]!;
      const entry = await candidate(ref, context);
      if (entry.parentRef !== parent)
        throw new Error('Metric candidate repair chain mismatch');
      parent = ref;
      const measured = await assessment(
        summary.measurementRefs[i]!,
        ref,
        context,
      );
      const afterConditions = await artifact(measured, 'conditions', context);
      if (
        ['mode', 'taskDigest', 'adapterDigest', 'sdkBuildDigest'].some(
          (key) => beforeConditions[key] !== afterConditions[key],
        )
      )
        throw new Error('Metric comparison provenance mismatch');
      const valid = scalar(measured, 'candidateValid');
      if (valid !== 0 && valid !== 1)
        throw new Error('Metric correctness result missing');
      correct = valid === 1;
      after = scalar(measured, 'latencyMeanMs');
      if (i < summary.candidateRefs.length - 1 && correct)
        throw new Error('Correct metric candidate cannot enter repair');
      if (
        correct &&
        (measured.comparisonKey !== incumbent.comparisonKey ||
          after === null ||
          after <= 0)
      )
        throw new Error('Metric candidate timing is not comparable');
    }
    if (correct) {
      if (summary.decisionRef === null)
        throw new Error('Metric candidate selection missing');
      const decision = object(
        await context.artifacts.readJson(summary.decisionRef),
      );
      validate(metricDecisionSchema, decision, 'Metric selection');
      const feedback = await readDecisionFeedback(
        summary.measurementRefs.at(-1)!,
        summary.decisionRef,
        summary.candidateRefs.at(-1)!,
        context,
      );
      if (
        !Array.isArray(decision.measurementRefs) ||
        decision.measurementRefs[0] !== summary.incumbentMeasurementRef ||
        decision.metric !== 'latencyMeanMs' ||
        decision.direction !== 'minimize' ||
        decision.incumbentValue !== before
      )
        throw new Error('Metric selection objective mismatch');
      accepted =
        after! <
          before - before * Number(decision.minRelativeImprovement ?? 0) &&
        feedback.constraints.every((value) => value <= 0);
      if (
        accepted !== decision.accepted ||
        summary.facts.outcome !== (accepted ? 'adopted' : 'verified-no-gain')
      )
        throw new Error('Metric selection facts mismatch');
    } else if (
      summary.facts.outcome !== 'verification-failed' ||
      summary.decisionRef !== null ||
      after !== null
    )
      throw new Error('Invalid metric candidate cannot claim timing');
  }
  return {
    outcome: summary.facts.outcome,
    wasTransformCorrect: correct,
    baselineMs: before,
    candidateMs: after,
    improvement: after === null ? null : (before - after) / before,
    accepted,
    selectedCandidateRef: accepted
      ? summary.candidateRefs.at(-1)!
      : summary.parentCandidateRef,
  };
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
      canonical(stored.facts) !== canonical(await facts(stored, context))
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
    const parent = await candidate(analysis.parentCandidateRef, context);
    const measured = await assessment(
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
    if (analysis.sourceDigest !== hash(await code(parent, context)))
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
async function failure(
  input: Extract<
    MetricsOperatorProposerInput,
    { action: 'propose' | 'repair' }
  >,
  parentRef: string,
  analysisRef: string,
  error: Error,
  context: RuntimeContext,
): Promise<OperatorProposerOutput> {
  const errorRef = await context.artifacts.putJson({
    schemaVersion: 'rsi.operator-model-error/v1',
    experimentId: context.experimentId,
    phase: 'metrics',
    round: input.round,
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
export async function executeMetricsProposer(
  input: MetricsOperatorProposerInput,
  context: RuntimeContext,
  services: RuntimeContext,
  config: OperatorProposerConfig,
  loaded: OperatorResources,
  hardware: HardwareContext | null,
): Promise<OperatorProposerOutput> {
  let analysis: MetricsAnalysis, analysisRef: string;
  const window = config.historyWindow ?? 5;
  let parent: Candidate, incumbent: JsonObject, diagnostic: JsonObject;
  if (input.action === 'propose') {
    parent = await candidate(input.parentCandidateRef, context);
    incumbent = await assessment(
      input.incumbentMeasurementRef,
      parent.ref,
      context,
    );
    if (scalar(incumbent, 'candidateValid') !== 1)
      throw new Error('Metric optimization requires a valid incumbent');
    const task = await loadOperatorTask(config.task.directory);
    if (
      (await artifact(incumbent, 'conditions', context)).taskDigest !==
      task.taskDigest
    )
      throw new Error('Metric task identity mismatch');
    diagnostic = await profile(
      input.diagnosticMeasurementRef,
      parent,
      incumbent,
      context,
    );
    analysis = {
      schemaVersion: 'rsi.operator-metrics-analysis/v1',
      experimentId: context.experimentId,
      round: input.round,
      parentCandidateRef: parent.ref,
      incumbentMeasurementRef: input.incumbentMeasurementRef,
      diagnosticMeasurementRef: input.diagnosticMeasurementRef,
      sourceDigest: hash(await code(parent, context)),
      resourcesDigest: loaded.digest,
      embeddingDigest: hash(await readFile(config.embedding.identityFile)),
      hardwareDigest: hardware?.sha256 ?? null,
      bottleneck: null,
      knowledgeContext: '',
      retrievalRef: null,
      retrievalStatus: 'skipped',
    };
    analysisRef = await context.artifacts.putJson(analysis);
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
        hash(await readFile(config.embedding.identityFile)) ||
      analysis.hardwareDigest !== (hardware?.sha256 ?? null)
    )
      throw new Error('Metric analysis identity mismatch');
    parent = await candidate(analysis.parentCandidateRef, context);
    incumbent = await assessment(
      analysis.incumbentMeasurementRef,
      parent.ref,
      context,
    );
    if (analysis.sourceDigest !== hash(await code(parent, context)))
      throw new Error('Metric analysis parent source mismatch');
    diagnostic = await profile(
      analysis.diagnosticMeasurementRef,
      parent,
      incumbent,
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
  const history = prior.summaries.slice(-window);
  if (input.action === 'summarize') {
    if (
      input.parentCandidateRef !== parent.ref ||
      input.incumbentMeasurementRef !== incumbent.ref
    )
      throw new Error('Metric summary parent mismatch');
    const actions = (await context.facts.list('calls'))
      .filter(
        (call) =>
          call.experimentId === context.experimentId &&
          call.pluginId === 'proposer.operator' &&
          call.status === 'succeeded' &&
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
    const actionSummary = actions
      .map(
        (action) => `${action.action}: ${action.status}; ${action.rationale}`,
      )
      .join('\n')
      .slice(0, 4000);
    const evidence = input.measurementRefs.length
      ? await context.readEvidence(input.measurementRefs, {
          view: 'training-summary',
        })
      : null;
    const draft: MetricsSummary = {
      schemaVersion: 'rsi.operator-metrics-summary/v1',
      actionSummary,
      experimentId: context.experimentId,
      round: input.round,
      analysisRef,
      parentCandidateRef: parent.ref,
      incumbentMeasurementRef: input.incumbentMeasurementRef,
      candidateRefs: input.candidateRefs,
      measurementRefs: input.measurementRefs,
      decisionRef: input.decisionRef,
      candidateDiagnosticMeasurementRef:
        input.candidateDiagnosticMeasurementRef,
      facts: {
        outcome: input.outcome,
        wasTransformCorrect: null,
        baselineMs: 1,
        candidateMs: null,
        improvement: null,
        accepted: false,
        selectedCandidateRef: parent.ref,
      },
      summaryStatus: 'unavailable',
      explanation: '',
      lessons: [],
      avoidPatterns: [],
      tryPatterns: [],
    };
    draft.facts = await facts(draft, context);
    let candidateProfile: JsonObject | null = null;
    if (input.candidateDiagnosticMeasurementRef !== null) {
      if (!draft.facts.accepted)
        throw new Error(
          'Non-promoted metric candidate cannot claim new diagnostics',
        );
      const selected = await candidate(
        draft.facts.selectedCandidateRef,
        context,
      );
      candidateProfile = await profile(
        input.candidateDiagnosticMeasurementRef,
        selected,
        await assessment(input.measurementRefs.at(-1)!, selected.ref, context),
        context,
        false,
      );
    }
    try {
      const response = await requestOperatorAgent(
        'summarize',
        {
          agentRef: config.agentRef,
          goal: 'Summarize the confirmed metric optimization attempt; causes remain hypotheses.',
          prompt: loaded.prompts.summarize,
          files: await files(
            await candidate(input.candidateRefs.at(-1) ?? parent.ref, context),
            config,
            context,
          ),
          input: {
            stage: 'summarize',
            phase: 'metrics',
            analysis,
            profile: diagnostic,
            candidateProfile,
            actions,
            evidence,
            history,
            staticHistory: staticHistory?.summaries ?? [],
            facts: draft.facts,
          },
          outputSchema: summaryResponseSchema,
        },
        context,
        config.modelRequestTimeoutMs,
      );
      Object.assign(draft, {
        summaryStatus: 'available',
        explanation: string(response.explanation),
        lessons: strings(response.lessons),
        avoidPatterns: strings(response.avoidPatterns),
        tryPatterns: strings(response.tryPatterns),
      });
    } catch (error) {
      if (!(error instanceof OperatorModelOutputError)) throw error;
      draft.explanation = `Summary unavailable: ${error.message}`.slice(
        0,
        4000,
      );
    }
    validate(metricsSummarySchema, draft, 'Metric summary');
    const summaryRef = await context.artifacts.putJson(draft);
    const historyRef = await context.artifacts.putJson({
      ...prior.history,
      summaryRefs: [...prior.history.summaryRefs, summaryRef],
    });
    await priorHistory(
      historyRef,
      input.round + 1,
      draft.facts.selectedCandidateRef,
      context,
    );
    return { action: 'summarize', summaryRef, historyRef };
  }
  if (input.action === 'propose') {
    try {
      const reply = await requestOperatorAgent(
        'diagnose-metrics',
        {
          agentRef: config.agentRef,
          goal: input.goal,
          prompt: loaded.prompts['diagnose-metrics'],
          files: await files(parent, config, context),
          input: {
            stage: 'diagnose-metrics',
            profile: diagnostic,
            history,
            staticHistory: staticHistory?.summaries ?? [],
            hardwareContext: hardware?.text ?? null,
          },
          outputSchema: metricsBottleneckSchema,
        },
        context,
        config.modelRequestTimeoutMs,
      );
      try {
        analysis.bottleneck = parseMetricsBottleneck(reply, diagnostic);
      } catch (error) {
        throw new OperatorModelOutputError(
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
      }
    } catch (error) {
      if (!(error instanceof OperatorModelOutputError)) throw error;
      return failure(input, parent.ref, analysisRef, error, context);
    }
    const bottleneck = analysis.bottleneck;
    try {
      const retrieved = await retrieveMetricsKnowledge(
        `${bottleneck.category}: ${bottleneck.summary} ${bottleneck.recommendedFix}`,
        config.embedding,
        context,
      );
      if (
        retrieved.resourcesDigest !== loaded.digest ||
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
  } else {
    const failed = await candidate(input.failedCandidateRef, context);
    const measured = await assessment(
      input.measurementRef,
      failed.ref,
      context,
    );
    if (scalar(measured, 'candidateValid') !== 0)
      throw new Error('Metric repair requires a confirmed candidate failure');
    const before = await artifact(incumbent, 'conditions', context),
      after = await artifact(measured, 'conditions', context);
    if (
      ['mode', 'taskDigest', 'adapterDigest', 'sdkBuildDigest'].some(
        (key) => before[key] !== after[key],
      )
    )
      throw new Error('Metric repair assessment identity mismatch');
    if (analysis.bottleneck === null)
      throw new Error('Metric repair requires a completed analysis');
    let cursor = failed;
    for (let depth = 0; depth < input.repairIndex; depth++) {
      if (cursor.parentRef === null)
        throw new Error('Metric repair ancestry mismatch');
      cursor = await candidate(cursor.parentRef, context);
    }
    if (cursor.ref !== parent.ref)
      throw new Error('Metric repair index does not match parent chain');
    parent = failed;
  }
  try {
    const response = await requestOperatorAgent(
      input.action === 'propose' ? 'generate' : 'repair',
      {
        agentRef: config.agentRef,
        goal: input.goal,
        prompt:
          (input.action === 'propose'
            ? loaded.metricsGenerate
            : loaded.prompts.repair) +
          '\n\n' +
          loaded.guidelines,
        files: await files(parent, config, context),
        input: {
          stage: input.action === 'propose' ? 'generate' : 'repair',
          phase: 'metrics',
          analysis,
          profile: diagnostic,
          history,
          staticHistory: staticHistory?.summaries ?? [],
          hardwareContext: hardware?.text ?? null,
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
        'Metric candidate commit',
      );
      if (
        result.action !== 'commit' ||
        !['created', 'no-change'].includes(String(result.status))
      )
        throw new Error('Metric candidate was not committed');
      if (result.status === 'created')
        return {
          action: input.action,
          status: 'created',
          candidateRef: string(result.candidateRef),
          diffRef: string(result.diffRef),
          rationale: string(response.reason),
          analysisRef,
          reasonCode: 'created',
        };
      return {
        action: input.action,
        status: 'no-change',
        candidateRef: parent.ref,
        diffRef: null,
        rationale: string(response.reason),
        analysisRef,
        reasonCode: 'no-supported-change',
      };
    } finally {
      await services.workspaces.release(workspace.ref);
    }
  } catch (error) {
    if (!(error instanceof OperatorModelOutputError)) throw error;
    return failure(input, parent.ref, analysisRef, error, context);
  }
}
