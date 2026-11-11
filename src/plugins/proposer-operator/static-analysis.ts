import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type OperatorProposerInput,
  type RuntimeContext,
} from '../../contracts/index.js';
import { digest, object, string } from '../../shared/json.js';
import { parseConfig } from '../../shared/schema.js';
import { loadOperatorTask } from '../shared/operator-task.js';
import {
  type OperatorProposerConfig,
  type HardwareContext,
  type OperatorResources,
  type PreparedAttempt,
  type AnalysisReceipt,
} from './schema.js';
import {
  type OperatorAnalysis,
  diagnosisResponseSchema,
  analysisSchema,
} from '../shared/operator-attempt/schema.js';
import {
  readOperatorCandidate,
  readOperatorSource,
  readOperatorMeasurement,
  readAssessment,
  operatorScalar,
  parseStaticDiagnosis,
  readAnalysis,
  readStaticHistory,
} from '../shared/operator-attempt/service.js';
import {
  OperatorModelOutputError,
  requestOperatorAgent,
} from '../shared/operator-attempt/agent.js';
import { sha, retrieveStaticKnowledge } from './resources.js';
import { operatorSnapshot } from './source-snapshot.js';

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

async function baseAnalysis(
  config: OperatorProposerConfig,
  entryRef: string,
  baselineRef: string,
  context: RuntimeContext,
  loaded: OperatorResources,
): Promise<OperatorAnalysis> {
  const entry = await readOperatorCandidate(entryRef, context),
    baseline = await readAssessment(baselineRef, entryRef, context);
  const source = await readOperatorSource(entry, baseline, context);
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
      ...source.identity,
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
      }),
    },
    baselineMs: mean,
    issues: [],
    matches: [],
    knowledgeContext: '',
  };
}
async function existingAnalysis(
  config: OperatorProposerConfig,
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
    config,
    stored.identity.entryCandidateRef,
    stored.identity.baselineMeasurementRef,
    context,
    loaded,
  );
  return readAnalysis(ref, current.identity, context);
}
export async function prepareStatic(
  config: OperatorProposerConfig,
  hardware: HardwareContext | null,
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
      config,
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
    const entry = await readOperatorCandidate(input.entryCandidateRef, context);
    const baseline = await readOperatorMeasurement(
      input.baselineMeasurementRef,
      context,
    );
    const response = await requestOperatorAgent(
      'diagnose',
      config.agentRef,
      {
        goal: input.goal,
        prompt: loaded.prompts.diagnose,
        ...(await operatorSnapshot(entry, config, baseline, context)),
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
        (await readOperatorSource(entry, baseline, context)).source,
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
    analysis = await existingAnalysis(config, analysisRef, context, loaded);
  }
  const identity = analysis.identity;
  if (
    input.action === 'propose' &&
    (identity.entryCandidateRef !== input.entryCandidateRef ||
      identity.baselineMeasurementRef !== input.baselineMeasurementRef)
  )
    throw new Error('Operator proposal entry identity mismatch');
  const prior = await readStaticHistory(
    input.historyRef,
    analysisRef,
    input.attempt,
    context,
  );
  if (input.action === 'propose' && !analysis.diagnosisComplete)
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
    generationContext: {
      analysis,
      history:
        config.historyWindow === 0
          ? []
          : (prior?.summaries ?? []).slice(-(config.historyWindow ?? 5)),
      hardwareContext: hardware?.text ?? null,
    },
    generatePrompt: loaded.prompts.generate,
    noChange: analysis.issues.length
      ? null
      : {
          reasonCode: 'no-static-issues',
          rationale: 'No supported static issues were diagnosed.',
        },
  };
}
