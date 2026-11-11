import { readFile } from 'node:fs/promises';
import {
  type Candidate,
  type JsonObject,
  type OperatorProposerInput,
  type RuntimeContext,
} from '../../contracts/index.js';
import { loadOperatorTask } from '../shared/operator-task.js';
import {
  type OperatorProposerConfig,
  type HardwareContext,
  type OperatorResources,
  type PreparedAttempt,
  type AnalysisReceipt,
} from './schema.js';
import {
  type MetricsAnalysis,
  metricsDiagnosisSchema,
} from '../shared/operator-attempt/schema.js';
import {
  readOperatorCandidate,
  readMetricsAnalysis,
  readOperatorSource,
  readOperatorArtifact,
  readAssessment,
  operatorScalar,
  readHistory,
  parseMetricsDiagnosis,
  profile,
  priorHistory,
} from '../shared/operator-attempt/service.js';
import {
  OperatorModelOutputError,
  requestOperatorAgent,
} from '../shared/operator-attempt/agent.js';
import {
  sha,
  MetricsRetrievalUnavailable,
  retrieveMetricsKnowledge,
} from './resources.js';
import { operatorSnapshot } from './source-snapshot.js';

export async function prepareMetrics(
  config: OperatorProposerConfig,
  hardware: HardwareContext | null,
  input: Extract<OperatorProposerInput, { phase: 'metrics' }>,
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
      ...(await readOperatorSource(parent, baseline, context)).identity,
      resourcesDigest: loaded.digest,
      embeddingDigest: sha(await readFile(config.embedding.identityFile)),
      hardwareDigest: hardware?.sha256 ?? null,
      diagnosis: null,
      knowledgeContext: '',
      retrievalRef: null,
      retrievalStatus: 'skipped',
    };
    analysisRef = await context.artifacts.putJson(analysis);
    receipt.analysisRef = analysisRef;
  } else {
    analysisRef = input.analysisRef;
    ({ analysis, parent, baseline, diagnostic } = await readMetricsAnalysis(
      analysisRef,
      input.round,
      context,
    ));
    if (
      analysis.resourcesDigest !== loaded.digest ||
      analysis.embeddingDigest !==
        sha(await readFile(config.embedding.identityFile)) ||
      analysis.hardwareDigest !== (hardware?.sha256 ?? null)
    )
      throw new Error('Metric analysis identity mismatch');
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
    history:
      config.historyWindow === 0
        ? []
        : prior.summaries.slice(-(config.historyWindow ?? 5)),
    staticHistory: staticHistory?.summaries ?? [],
  };
  if (input.action === 'propose') {
    const response = await requestOperatorAgent(
      'diagnose-metrics',
      config.agentRef,
      {
        goal: input.goal,
        prompt: loaded.prompts['diagnose-metrics'],
        ...(await operatorSnapshot(parent, config, baseline, context)),
        input: {
          stage: 'diagnose-metrics',
          profile: diagnostic,
          history: metricContext.history,
          staticHistory: metricContext.staticHistory,
          hardwareContext: hardware?.text ?? null,
        },
        outputSchema: metricsDiagnosisSchema,
      },
      context,
      config.modelRequestTimeoutMs,
    );
    try {
      analysis.diagnosis = parseMetricsDiagnosis(response, diagnostic);
    } catch (error) {
      throw new OperatorModelOutputError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    const diagnosis = analysis.diagnosis;
    if (diagnosis.status === 'hypothesis') {
      try {
        const retrieved = await retrieveMetricsKnowledge(
          `${diagnosis.category}: ${diagnosis.summary} ${diagnosis.recommendedFix}`,
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
    }
    analysisRef = await context.artifacts.putJson(analysis);
    receipt.analysisRef = analysisRef;
  }
  if (input.action === 'repair' && analysis.diagnosis?.status !== 'hypothesis')
    throw new Error('Metric repair requires a completed analysis');
  return {
    parent,
    baseline,
    analysisRef,
    generationContext: {
      phase: 'metrics',
      analysis,
      profile: diagnostic,
      history: metricContext.history,
      staticHistory: metricContext.staticHistory,
      hardwareContext: hardware?.text ?? null,
    },
    generatePrompt: loaded.metricsGenerate,
    noChange:
      analysis.diagnosis?.status === 'no-new-hypothesis'
        ? {
            reasonCode: 'no-new-hypothesis',
            rationale: analysis.diagnosis.reason,
          }
        : null,
  };
}
