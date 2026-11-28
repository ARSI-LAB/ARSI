import { readFile } from 'node:fs/promises';
import {
  type JsonObject,
  type OperationDefinition,
  type OperatorSummarizerInput,
  type OperatorSummarizerOutput,
  type RuntimeContext,
} from '../../contracts/index.js';
import { canonical, strings } from '../../shared/json.js';
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
  assertSummaryEvidence,
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
import type { OperatorSummarizerConfig } from './schema.js';
import { operatorSummarizerDoctorRules } from './doctor.js';
import {
  candidateMetricFeedback,
  projectMetricProfile,
} from '../shared/operator-attempt/metric-evidence.js';

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
    const content = parseConfig<
      Pick<
        MetricsSummary,
        'explanation' | 'lessons' | 'avoidPatterns' | 'tryPatterns'
      >
    >(summaryResponseSchema, response, 'Operator summary response');
    try {
      assertSummaryEvidence(content, strings(request.input.measurementRefs));
    } catch (error) {
      throw new OperatorModelOutputError(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    return { summaryStatus: 'available', ...content };
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

export async function readSummaryPrompt(
  path: string,
  signal: AbortSignal,
): Promise<string> {
  const prompt = await readFile(path, { encoding: 'utf8', signal });
  if (!prompt.trim())
    throw new Error('Operator summary promptFile must not be empty');
  return prompt;
}

export const createOperatorSummarizer: OperationDefinition<
  OperatorSummarizerInput,
  OperatorSummarizerOutput,
  OperatorSummarizerConfig
>['create'] = async (config, services) => {
  services.event?.on('rsi/doctor', operatorSummarizerDoctorRules);

  async function explain(
    prompt: string,
    input: OperatorSummarizerInput,
    parentRef: string,
    baselineMeasurementRef: string,
    details: JsonObject & { facts: { baselineMs: number } },
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
    const goal =
      'Summarize the completed operator optimization attempt using confirmed facts. Treat proposed causes as hypotheses.';
    const explanation = await summaryExplanation(
      config.agentRef,
      {
        goal,
        taskMessage: {
          templates: config.messageTemplates,
          fallback: goal,
          variables: {
            outcome: input.outcome,
            actionSummary,
            baselineMs: details.facts.baselineMs,
          },
          stage:
            input.phase === 'static'
              ? { name: 'summarize', variables: { attempt: input.attempt } }
              : {
                  name: 'summarize-metrics',
                  variables: { round: input.round },
                },
        },
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
      context.signal.throwIfAborted();
      const prompt = await readSummaryPrompt(config.promptFile, context.signal);
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
          prompt,
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
        if (facts.wasTransformCorrect !== true)
          throw new Error(
            'Metric candidate diagnostics require a verified correct attempt',
          );
        const measured = await readOperatorCandidate(
          input.candidateRefs.at(-1)!,
          context,
        );
        candidateProfile = await profile(
          input.candidateDiagnosticMeasurementRef,
          measured,
          await readAssessment(
            input.measurementRefs.at(-1)!,
            measured.ref,
            context,
          ),
          context,
          false,
        );
      }
      const feedback =
        candidateProfile === null
          ? null
          : candidateMetricFeedback(diagnostic, candidateProfile);
      const content = await explain(
        prompt,
        input,
        parent.ref,
        input.incumbentMeasurementRef,
        {
          analysis,
          facts,
          profile: projectMetricProfile(diagnostic),
          candidateProfile: feedback,
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
          ...(feedback === null ? {} : { candidateProfileFeedback: feedback }),
        },
        prior.history,
        context,
      );
    },
    async dispose() {},
  };
};
