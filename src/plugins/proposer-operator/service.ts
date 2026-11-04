import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentInput,
  Candidate,
  JsonObject,
  JsonValue,
  OperationDefinition,
  OperatorProposerInput,
  OperatorProposerOutput,
  RuntimeContext,
} from '../../contracts/index.js';
import { operatorProposerContract } from '../../contracts/plugin-types/proposer-operator.js';
import { applicationContract } from '../../contracts/plugin-types/application.js';
import {
  recordSchema,
  validateMeasurement,
} from '../../contracts/models/measurement.js';
import { digest, object, string, strings } from '../../shared/json.js';
import { parseConfig, validate } from '../../shared/schema.js';
import { applyEdits, resourceFiles } from '../shared/agent-editing/index.js';
import { loadOperatorTask } from '../evaluator-operatorbench/task.js';
import { parseStaticDiagnosis, readAnalysis, readHistory } from './context.js';
import { requestOperatorAgent, OperatorModelOutputError } from './agent.js';
import {
  operatorEditConstraints as editConstraints,
  operatorEditOutputSchema,
  validateOperatorEdits,
} from './editing.js';
import { readHardwareContext } from './hardware-context.js';
import {
  executeMetricsProposer,
  type OperatorResources,
} from './metrics-service.js';
import { retrieveStaticKnowledge } from './retrieval.js';
import {
  analysisSchema,
  configSchema,
  historySchema,
  staticDiagnosisSchema,
  summaryResponseSchema,
  summarySchema,
  type OperatorAnalysis,
  type OperatorHistory,
  type OperatorProposerConfig,
  type OperatorSummary,
} from './schema.js';

const directory = fileURLToPath(new URL('./', import.meta.url));
const sha = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const diagnosisResponseSchema = recordSchema({ issues: staticDiagnosisSchema });

async function resources(): Promise<OperatorResources> {
  const bytes = await readFile(join(directory, 'knowledge/manifest.json'));
  const manifest = object(JSON.parse(bytes.toString('utf8')));
  if (
    manifest.schemaVersion !== 'rsi.operator-knowledge/v1' ||
    !Array.isArray(manifest.resources)
  )
    throw new Error('Operator resource manifest is invalid');
  const contents = new Map<string, string>();
  const base = await realpath(directory);
  for (const raw of manifest.resources) {
    const entry = object(raw),
      path = string(entry.path);
    const resolved = await realpath(resolve(directory, path)),
      local = relative(base, resolved);
    if (
      isAbsolute(local) ||
      local === '..' ||
      local.startsWith('..' + sep) ||
      !(await lstat(resolve(directory, path))).isFile()
    )
      throw new Error('Operator resource escapes its directory');
    const content = await readFile(resolved);
    if (sha(content) !== entry.sha256)
      throw new Error(`Operator resource changed: ${path}`);
    contents.set(
      path,
      new TextDecoder('utf-8', { fatal: true }).decode(content),
    );
  }
  const get = (name: string): string =>
    string(contents.get(name), `Operator resource ${name}`);
  return {
    digest: sha(bytes),
    prompts: {
      diagnose: get('prompts/diagnose.md'),
      'diagnose-metrics': get('prompts/diagnose-metrics.md'),
      generate: get('prompts/generate.md'),
      repair: get('prompts/repair.md'),
      summarize: get('prompts/summarize.md'),
    },
    metricsGenerate: get('prompts/generate-metrics.md'),
    guidelines: get('prompts/triton-ascend-guidelines.md'),
  };
}
function scalar(measurement: JsonObject, name: string): number | null {
  const metric = object(object(measurement.metrics)[name]);
  if (metric.status === 'unavailable') return null;
  const value = object(metric.value);
  if (
    metric.status !== 'available' ||
    value.kind !== 'scalar' ||
    typeof value.value !== 'number' ||
    !Number.isFinite(value.value)
  )
    throw new Error(`Operator metric ${name} unavailable`);
  return value.value;
}
async function candidate(
  ref: string,
  context: RuntimeContext,
): Promise<Candidate> {
  const value = await context.readCandidate(ref);
  if (value.ref !== ref || value.experimentId !== context.experimentId)
    throw new Error('Operator candidate ownership mismatch');
  return value;
}
async function measurement(
  ref: string,
  candidateRef: string,
  context: RuntimeContext,
): Promise<JsonObject> {
  const value = await context.readMeasurement(ref);
  validateMeasurement(value);
  if (
    value.ref !== ref ||
    value.experimentId !== context.experimentId ||
    value.candidateRef !== candidateRef ||
    object(value.evaluator).pluginId !== 'evaluator.operatorbench'
  )
    throw new Error('Operator measurement ownership or candidate mismatch');
  return value;
}
async function source(
  candidate: Candidate,
  context: RuntimeContext,
): Promise<string> {
  return string(
    (await resourceFiles(candidate.artifactRef, context))['input.py'],
    'Operator input.py',
  );
}
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
    loaded: Awaited<ReturnType<typeof resources>>,
  ): Promise<OperatorAnalysis> {
    const entry = await candidate(entryRef, context),
      baseline = await measurement(baselineRef, entryRef, context);
    const code = await source(entry, context);
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
    const mean = scalar(baseline, 'latencyMeanMs');
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
    loaded: Awaited<ReturnType<typeof resources>>,
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
  async function files(
    parent: Candidate,
    context: RuntimeContext,
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {
      'input.py': await source(parent, context),
    };
    for (const name of ['problem.py', 'test.py', 'task.json'])
      result['context/task/' + name] = await readFile(
        join(config.task.directory, name),
        'utf8',
      );
    return result;
  }
  async function edit(
    action: 'propose' | 'repair',
    parent: Candidate,
    analysisRef: string,
    analysis: OperatorAnalysis,
    prior: OperatorHistory | null,
    goal: string,
    context: RuntimeContext,
    loaded: Awaited<ReturnType<typeof resources>>,
    evidence: JsonValue = null,
  ): Promise<OperatorProposerOutput> {
    const request: AgentInput = {
      agentRef: config.agentRef,
      goal,
      prompt:
        loaded.prompts[action === 'propose' ? 'generate' : 'repair'] +
        '\n\n' +
        loaded.guidelines,
      files: await files(parent, context),
      input: {
        stage: action === 'propose' ? 'generate' : 'repair',
        analysis,
        history: (prior?.summaries ?? []).slice(-(config.historyWindow ?? 5)),
        hardwareContext: hardware?.text ?? null,
        evidence,
        target: (await context.applicationMetadata()).target ?? null,
        editConstraints,
      },
      outputSchema: operatorEditOutputSchema,
    };
    const response = await requestOperatorAgent(
      action === 'propose' ? 'generate' : 'repair',
      request,
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
      const committed = await context.application({
        action: 'commit',
        parentCandidateRef: parent.ref,
        editRef: workspace.ref,
        editConstraints,
      });
      validate(
        applicationContract.output_schema,
        committed,
        'Operator Application commit',
      );
      if (committed.action !== 'commit')
        throw new Error('Operator Application did not commit');
      const candidateRef = string(committed.candidateRef),
        rationale = typeof response.reason === 'string' ? response.reason : '';
      if (committed.status === 'created')
        return {
          action,
          status: 'created',
          candidateRef,
          diffRef: string(committed.diffRef),
          rationale,
          analysisRef,
          reasonCode: 'created',
        };
      if (
        committed.status !== 'no-change' ||
        committed.diffRef !== null ||
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
  return {
    async execute(input, context) {
      validate(
        operatorProposerContract.input_schema,
        input,
        'Operator Proposer input',
      );
      context.signal.throwIfAborted();
      const loaded = await resources();
      if (input.phase === 'metrics')
        return executeMetricsProposer(
          input,
          context,
          services,
          config,
          loaded,
          hardware,
        );
      let errorAnalysisRef = input.analysisRef;
      try {
        if (input.action === 'propose') {
          let analysis: OperatorAnalysis, analysisRef: string;
          if (input.analysisRef === null) {
            if (input.attempt !== 1 || input.historyRef !== null)
              throw new Error(
                'Initial operator analysis requires the first attempt',
              );
            const base = await baseAnalysis(
              input.entryCandidateRef,
              input.baselineMeasurementRef,
              context,
              loaded,
            );
            const baseRef = await context.artifacts.putJson(base);
            errorAnalysisRef = baseRef;
            await readAnalysis(baseRef, base.identity, context);
            await saveDiagnostic(context, 'analysis-draft.json', {
              analysisRef: baseRef,
            });
            const entry = await candidate(input.entryCandidateRef, context);
            const reply = await requestOperatorAgent(
              'diagnose',
              {
                agentRef: config.agentRef,
                goal: input.goal,
                prompt: loaded.prompts.diagnose,
                files: await files(entry, context),
                input: {
                  stage: 'diagnose',
                  baseline: base,
                  task: (await loadOperatorTask(config.task.directory))
                    .definition,
                },
                outputSchema: diagnosisResponseSchema,
              },
              context,
              config.modelRequestTimeoutMs,
            );
            let issues;
            try {
              issues = parseStaticDiagnosis(
                reply.issues,
                await source(entry, context),
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
                retrieved.resourcesDigest !== loaded.digest
              )
                throw new Error('Operator retrieval identity changed');
              analysis = {
                ...analysis,
                matches: retrieved.matches,
                knowledgeContext: retrieved.knowledgeContext,
              };
            }
            analysisRef = await context.artifacts.putJson(analysis);
            errorAnalysisRef = analysisRef;
            await readAnalysis(analysisRef, base.identity, context);
            await saveDiagnostic(context, 'analysis.json', { analysisRef });
          } else {
            analysisRef = input.analysisRef;
            analysis = await existingAnalysis(analysisRef, context, loaded);
            if (
              analysis.identity.entryCandidateRef !== input.entryCandidateRef ||
              analysis.identity.baselineMeasurementRef !==
                input.baselineMeasurementRef
            )
              throw new Error('Operator proposal entry identity mismatch');
          }
          const prior = await history(
            input.historyRef,
            analysisRef,
            input.attempt,
            context,
          );
          if (analysis.diagnosisComplete === false)
            throw new OperatorModelOutputError(
              'Static diagnosis did not produce a valid result; no empty-diagnosis claim is available',
            );
          if (!analysis.issues.length)
            return {
              action: 'propose',
              status: 'no-change',
              candidateRef: input.entryCandidateRef,
              diffRef: null,
              rationale: 'No supported static issues were diagnosed.',
              analysisRef,
              reasonCode: 'no-static-issues',
            };
          return await edit(
            'propose',
            await candidate(input.entryCandidateRef, context),
            analysisRef,
            analysis,
            prior,
            input.goal,
            context,
            loaded,
          );
        }
        const analysis = await existingAnalysis(
          input.analysisRef,
          context,
          loaded,
        );
        const prior = await history(
          input.historyRef,
          input.analysisRef,
          input.attempt,
          context,
        );
        if (input.action === 'repair') {
          const failed = await candidate(input.failedCandidateRef, context),
            assessment = await measurement(
              input.measurementRef,
              failed.ref,
              context,
            );
          const provenance = object(
            await context.artifacts.readJson(
              string(object(assessment.provenance).artifactRef),
            ),
          );
          if (
            assessment.status !== 'succeeded' ||
            assessment.finishedAt === null ||
            scalar(assessment, 'candidateValid') !== 0 ||
            provenance.cleanup !== 'confirmed' ||
            provenance.sourceDigest !==
              sha(Buffer.from(await source(failed, context))) ||
            provenance.artifactRef !== failed.artifactRef
          )
            throw new Error(
              'Operator repair requires a confirmed candidate failure',
            );
          const baseline = await context.readMeasurement(
            analysis.identity.baselineMeasurementRef,
          );
          const before = object(
              await context.artifacts.readJson(
                string(object(baseline.conditions).artifactRef),
              ),
            ),
            after = object(
              await context.artifacts.readJson(
                string(object(assessment.conditions).artifactRef),
              ),
            );
          if (
            ['mode', 'taskDigest', 'adapterDigest', 'sdkBuildDigest'].some(
              (key) => before[key] !== after[key],
            )
          )
            throw new Error('Operator repair assessment identity mismatch');
          let cursor = failed,
            depth = 0;
          while (
            cursor.ref !== analysis.identity.entryCandidateRef &&
            depth < 4
          ) {
            if (cursor.parentRef === null) break;
            cursor = await candidate(cursor.parentRef, context);
            depth++;
          }
          if (
            cursor.ref !== analysis.identity.entryCandidateRef ||
            depth !== input.repairIndex
          )
            throw new Error(
              'Operator repair parent chain does not match its index',
            );
          return await edit(
            'repair',
            failed,
            input.analysisRef,
            analysis,
            prior,
            input.goal,
            context,
            loaded,
            await context.readEvidence([input.measurementRef], {
              view: 'training-summary',
            }),
          );
        }
        if (input.entryCandidateRef !== analysis.identity.entryCandidateRef)
          throw new Error('Operator summary entry mismatch');
        let wasCorrect: boolean | null = null,
          candidateMs: number | null = null,
          accepted = false;
        if (!['no-change', 'proposal-failed'].includes(input.outcome)) {
          const lastRef = input.measurementRefs.at(-1),
            lastCandidate = input.candidateRefs.at(-1);
          if (!lastRef || !lastCandidate)
            throw new Error('Operator summary lacks the terminal measurement');
          const last = await measurement(lastRef, lastCandidate, context),
            correct = scalar(last, 'candidateValid');
          if (correct !== 0 && correct !== 1)
            throw new Error('Operator summary correctness unavailable');
          wasCorrect = correct === 1;
          candidateMs = scalar(last, 'latencyMeanMs');
          if (input.decisionRef !== null) {
            const decision = object(
              await context.artifacts.readJson(input.decisionRef),
            );
            if (typeof decision.accepted !== 'boolean')
              throw new Error('Operator summary decision missing acceptance');
            accepted = decision.accepted;
          }
        }
        const calls = (await context.facts.list('calls')).filter(
          (call) =>
            call.experimentId === context.experimentId &&
            call.pluginId === 'proposer.operator' &&
            call.status === 'succeeded',
        );
        const actions = calls
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
          );
        const rationale = actions
          .map((call) => String(object(call.output).rationale ?? ''))
          .join('\n');
        const actionSummary =
          rationale.length > 4000
            ? rationale.slice(0, 3900) +
              '\n[Truncated; full rationale remains in successful call receipts.]'
            : rationale;
        const draft: OperatorSummary = {
          schemaVersion: 'rsi.operator-summary/v1',
          experimentId: context.experimentId,
          analysisRef: input.analysisRef,
          attempt: input.attempt,
          candidateRefs: input.candidateRefs,
          measurementRefs: input.measurementRefs,
          decisionRef: input.decisionRef,
          techniqueIds: [
            ...new Set(analysis.issues.map((issue) => issue.issue_type)),
          ],
          actionSummary,
          facts: {
            outcome: input.outcome,
            wasTransformCorrect: wasCorrect,
            baselineMs: analysis.baselineMs,
            candidateMs,
            accepted,
          },
          explanation: '',
          lessons: [],
          avoidPatterns: [],
          tryPatterns: [],
        };
        validate(summarySchema, draft, 'Operator summary facts');
        const summaryRefs = prior?.summaryRefs ?? [];
        const draftRef = await context.artifacts.putJson(draft);
        const draftHistory = {
          schemaVersion: 'rsi.operator-history/v1',
          experimentId: context.experimentId,
          analysisRef: input.analysisRef,
          summaryRefs: [...summaryRefs, draftRef],
        };
        validate(historySchema, draftHistory, 'Operator draft history');
        await readHistory(
          await context.artifacts.putJson(draftHistory),
          context,
        );
        await saveDiagnostic(context, 'summary-facts.json', {
          draftSummaryRef: draftRef,
        });
        let response: JsonObject;
        let summaryStatus: 'available' | 'unavailable' = 'available';
        try {
          response = await requestOperatorAgent(
            'summarize',
            {
              agentRef: config.agentRef,
              goal: 'Summarize this completed operator optimization attempt using the confirmed facts.',
              prompt: loaded.prompts.summarize,
              files: await files(
                await candidate(input.candidateRefs.at(-1)!, context),
                context,
              ),
              input: {
                stage: 'summarize',
                analysis,
                history: prior?.summaries ?? [],
                facts: draft.facts,
                actionSummary,
                candidateRefs: input.candidateRefs,
                measurementRefs: input.measurementRefs,
                decisionRef: input.decisionRef,
              },
              outputSchema: summaryResponseSchema,
            },
            context,
            config.modelRequestTimeoutMs,
          );
        } catch (error) {
          if (!(error instanceof OperatorModelOutputError)) throw error;
          summaryStatus = 'unavailable';
          response = {
            explanation: ('Summary unavailable: ' + error.message).slice(
              0,
              4000,
            ),
            lessons: [],
            avoidPatterns: [],
            tryPatterns: [],
          };
        }
        const summary: OperatorSummary = {
          ...draft,
          summaryStatus,
          explanation:
            typeof response.explanation === 'string'
              ? response.explanation
              : '',
          lessons: strings(response.lessons),
          avoidPatterns: strings(response.avoidPatterns),
          tryPatterns: strings(response.tryPatterns),
        };
        const summaryRef = await context.artifacts.putJson(summary),
          historyRef = await context.artifacts.putJson({
            ...draftHistory,
            summaryRefs: [...summaryRefs, summaryRef],
          });
        await readHistory(historyRef, context);
        return { action: 'summarize', summaryRef, historyRef };
      } catch (error) {
        if (
          !(error instanceof OperatorModelOutputError) ||
          input.action === 'summarize' ||
          errorAnalysisRef === null
        )
          throw error;
        const errorRef = await context.artifacts.putJson({
          schemaVersion: 'rsi.operator-model-error/v1',
          experimentId: context.experimentId,
          phase: 'static',
          attempt: input.attempt,
          stage: input.action,
          message: error.message,
        });
        return {
          action: input.action,
          status: 'failed',
          candidateRef:
            input.action === 'propose'
              ? input.entryCandidateRef
              : input.failedCandidateRef,
          diffRef: null,
          analysisRef: errorAnalysisRef,
          errorRef,
          rationale: error.message,
          reasonCode: 'invalid-model-output',
        };
      }
    },
    async dispose() {},
  };
};
