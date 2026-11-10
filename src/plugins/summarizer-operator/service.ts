import { readFile } from 'node:fs/promises';
import {
  operatorSummarizerContract,
  type JsonObject,
  type OperationDefinition,
  type OperatorSummarizerInput,
  type OperatorSummarizerOutput,
  type RuntimeContext,
} from '../../contracts/index.js';
import { canonical, string, strings } from '../../shared/json.js';
import { parseConfig, validate } from '../../shared/schema.js';
import {
  requestOperatorAgent,
  sourceSnapshot,
  OperatorModelOutputError,
  type OperatorStageInput,
} from '../shared/operator-attempt/agent.js';
import {
  readMetricsAnalysis,
  priorHistory,
  profile,
  readAnalysis,
  readAssessment,
  readAttemptFacts,
  readStaticHistory,
  readOperatorCandidate,
  readOperatorSource,
  staticFacts,
} from '../shared/operator-attempt/service.js';
import {
  metricsSummarySchema,
  summaryResponseSchema,
  summarySchema,
  type MetricsHistory,
  type MetricsSummary,
  type OperatorHistoryArtifact,
  type OperatorSummary,
} from '../shared/operator-attempt/schema.js';
import { configSchema, type OperatorSummarizerConfig } from './schema.js';

function validateActions(
  input: OperatorSummarizerInput,
  parentRef: string,
): void {
  let current = parentRef;
  const created: string[] = [];
  for (const [index, action] of input.actions.entries()) {
    if (
      action.analysisRef !== input.analysisRef ||
      action.action !== (index === 0 ? 'propose' : 'repair')
    )
      throw new Error('Operator summary action order or analysis mismatch');
    if (action.status === 'created') {
      current = action.candidateRef;
      created.push(current);
    } else if (
      index !== input.actions.length - 1 ||
      action.candidateRef !== current
    )
      throw new Error('Operator summary terminal action mismatch');
  }
  const first = input.actions[0]!;
  if (
    (first.status === 'failed') !== (input.outcome === 'proposal-failed') ||
    (first.status === 'no-change') !== (input.outcome === 'no-change') ||
    (created.length && canonical(created) !== canonical(input.candidateRefs))
  )
    throw new Error('Operator summary action results differ from attempt');
}

async function summaryExplanation(
  agentRef: string,
  request: OperatorStageInput,
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
      agentRef,
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
      explanation: `Summary unavailable: ${error.message}`,
      lessons: [],
      avoidPatterns: [],
      tryPatterns: [],
    };
  }
}

async function storeSummary(
  summary: OperatorSummary | MetricsSummary,
  history: OperatorHistoryArtifact | MetricsHistory,
  context: RuntimeContext,
): Promise<OperatorSummarizerOutput> {
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

export const createOperatorSummarizer: OperationDefinition<
  OperatorSummarizerInput,
  OperatorSummarizerOutput,
  OperatorSummarizerConfig
>['create'] = async (rawConfig) => {
  const config = parseConfig<OperatorSummarizerConfig>(
    configSchema,
    rawConfig,
    'Operator Summarizer config',
  );
  const prompt = await readFile(config.promptFile, 'utf8');
  if (!prompt.trim())
    throw new Error('Operator summary promptFile must not be empty');

  async function explain(
    input: OperatorSummarizerInput,
    parentRef: string,
    baselineMeasurementRef: string,
    details: JsonObject,
    context: RuntimeContext,
  ) {
    const candidate = await readOperatorCandidate(
      input.candidateRefs.at(-1) ?? parentRef,
      context,
    );
    const measurement = await readAssessment(
      input.measurementRefs.at(-1) ?? baselineMeasurementRef,
      candidate.ref,
      context,
    );
    const source = await readOperatorSource(candidate, measurement, context);
    const actionSummary = input.actions
      .map((action) =>
        input.phase === 'static'
          ? action.rationale
          : `${action.action}: ${action.status}; ${action.rationale}`,
      )
      .join('\n');
    const evidence = input.measurementRefs.length
      ? await context.readEvidence(input.measurementRefs, {
          view: 'training-summary',
        })
      : null;
    const explanation = await summaryExplanation(
      config.agentRef,
      {
        goal: 'Summarize the completed operator optimization attempt using confirmed facts. Treat proposed causes as hypotheses.',
        prompt,
        sourcePath: source.sourcePath,
        sourceFiles: Object.keys(source.files),
        editablePaths: [],
        files: Object.fromEntries(
          Object.entries(source.files).map(([path, content]) => [
            sourceSnapshot + path,
            content,
          ]),
        ),
        input: {
          stage: 'summarize',
          phase: input.phase,
          actions: input.actions,
          actionSummary,
          evidence,
          candidateRefs: input.candidateRefs,
          measurementRefs: input.measurementRefs,
          decisionRef: input.decisionRef,
          ...details,
        },
        outputSchema: summaryResponseSchema,
      },
      context,
      config.modelRequestTimeoutMs,
    );
    return {
      experimentId: context.experimentId,
      analysisRef: input.analysisRef,
      candidateRefs: input.candidateRefs,
      measurementRefs: input.measurementRefs,
      decisionRef: input.decisionRef,
      actionSummary,
      ...explanation,
    };
  }

  return {
    async execute(input, context) {
      validate(
        operatorSummarizerContract.input_schema,
        input,
        'Operator Summarizer input',
      );
      context.signal.throwIfAborted();
      if (input.phase === 'static') {
        validateActions(input, input.entryCandidateRef);
        const analysis = await readAnalysis(input.analysisRef, null, context);
        if (input.entryCandidateRef !== analysis.identity.entryCandidateRef)
          throw new Error('Operator summary entry mismatch');
        const prior = await readStaticHistory(
          input.historyRef,
          input.analysisRef,
          input.attempt,
          context,
        );
        const baselineMeasurementRef = analysis.identity.baselineMeasurementRef;
        const facts = staticFacts(
          await readAttemptFacts(
            {
              ...input,
              rootCandidateRef: input.entryCandidateRef,
              baselineMeasurementRef,
            },
            context,
          ),
        );
        const content = await explain(
          input,
          input.entryCandidateRef,
          baselineMeasurementRef,
          {
            analysis,
            facts,
          },
          context,
        );
        return storeSummary(
          {
            schemaVersion: 'rsi.operator-summary/v1',
            ...content,
            facts,
            attempt: input.attempt,
            techniqueIds: [
              ...new Set(analysis.issues.map((issue) => issue.issue_type)),
            ],
          },
          {
            schemaVersion: 'rsi.operator-history/v1',
            experimentId: context.experimentId,
            analysisRef: input.analysisRef,
            summaryRefs: prior?.summaryRefs ?? [],
          },
          context,
        );
      }
      validateActions(input, input.parentCandidateRef);
      const { analysis, parent, diagnostic } = await readMetricsAnalysis(
        input.analysisRef,
        input.round,
        context,
      );
      if (
        analysis.parentCandidateRef !== input.parentCandidateRef ||
        analysis.incumbentMeasurementRef !== input.incumbentMeasurementRef
      )
        throw new Error('Metric summary analysis identity mismatch');
      const prior = await priorHistory(
        input.historyRef,
        input.round,
        parent.ref,
        context,
      );
      const facts = await readAttemptFacts(
        {
          ...input,
          rootCandidateRef: parent.ref,
          baselineMeasurementRef: input.incumbentMeasurementRef,
        },
        context,
      );
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
      const content = await explain(
        input,
        parent.ref,
        input.incumbentMeasurementRef,
        {
          analysis,
          facts,
          profile: diagnostic,
          candidateProfile,
        },
        context,
      );
      return storeSummary(
        {
          schemaVersion: 'rsi.operator-metrics-summary/v1',
          ...content,
          facts,
          round: input.round,
          parentCandidateRef: parent.ref,
          incumbentMeasurementRef: input.incumbentMeasurementRef,
          candidateDiagnosticMeasurementRef:
            input.candidateDiagnosticMeasurementRef,
        },
        prior.history,
        context,
      );
    },
    async dispose() {},
  };
};
