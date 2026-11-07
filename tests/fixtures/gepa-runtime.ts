import { piDefinition } from '../../src/plugins/agent-pi/index.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, matchesGlob } from 'node:path';
import { stringify } from 'yaml';
import type {
  AgentInput,
  AgentOutput,
  AgentbenchInput,
  AgentbenchOutput,
  ApplicationInput,
  ApplicationOutput,
  JsonObject,
  OperationDefinition,
} from '../../src/contracts/index.js';
import {
  agentContract,
  agentbenchContract,
  applicationContract,
} from '../../src/contracts/index.js';
import {
  evaluationFeedbackSchema,
  typedArtifact,
} from '../../src/contracts/models/measurement.js';
import { object, string } from '../../src/shared/json.js';
import { Manager } from '../../src/runtime/manager/index.js';
import { Registry } from '../../src/runtime/registry/index.js';
import { readPolicyDocument } from '../../src/runtime/compiler/document.js';
import { promptEvolutionSearchDefinition } from '../../src/plugins/search-prompt-evolution/index.js';
import { proposerDefinition } from '../../src/plugins/proposer-agent/index.js';
import {
  checkTarget,
  parseTarget,
  scanTree,
} from '../../src/plugins/shared/file-application/target.js';

interface EvaluationCall {
  candidateRef: string;
  taskIds: string[];
  files: Record<string, string>;
}

interface AgentCall {
  moduleId: string;
  maxModelCalls: number | undefined;
  modelCalls: number;
  input: JsonObject;
  files: JsonObject;
}

function fileTree(files: Record<string, string>): JsonObject {
  return {
    kind: 'file-tree',
    files: Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => ({
        path,
        mode: 0o644,
        base64: Buffer.from(content, 'utf8').toString('base64'),
      })),
  };
}

export function decodeTree(value: JsonObject): Record<string, string> {
  const files = Array.isArray(value.files) ? value.files : [];
  return Object.fromEntries(
    files.map((entry) => {
      const file = object(entry);
      return [
        string(file.path),
        Buffer.from(string(file.base64), 'base64').toString('utf8'),
      ];
    }),
  );
}

const fakeApplication: OperationDefinition<
  ApplicationInput,
  ApplicationOutput,
  JsonObject
> = {
  id: 'test.gepa-application',
  contract: applicationContract,
  configSchema: { type: 'object' },
  async create(config, services) {
    const baseline = object(config.files ?? {});
    const rawTarget: JsonObject = {
      schemaVersion: 'rsi.target/v1',
      id: 'gepa-modules',
      entries: Object.keys(baseline).map((path) => ({
        path,
        kind: 'file',
        description: `GEPA module ${path}`,
        changes: ['modify'],
        content: { encoding: 'utf-8', minBytes: 1 },
      })),
    };
    const target = parseTarget(rawTarget);
    return {
      async execute(input, context) {
        if (input.action === 'initialize') {
          const artifactRef = await services.artifacts.putJson(
            fileTree(
              Object.fromEntries(
                Object.entries(baseline).map(([path, value]) => [
                  path,
                  string(value),
                ]),
              ),
            ),
          );
          const initialCandidateRef = await context.recordCandidate(
            artifactRef,
            null,
          );
          return {
            action: 'initialize',
            initialCandidateRef,
            target: rawTarget,
            capabilities: [],
          };
        }
        if (input.action === 'commit') {
          const parent = await context.readCandidate(input.parentCandidateRef);
          const workspace = await services.workspaces.read(input.editRef);
          const after = await scanTree(workspace.directory);
          const parentSpace = await services.workspaces.create(
            parent.artifactRef,
          );
          let changed: boolean;
          try {
            changed =
              checkTarget(
                await scanTree(parentSpace.directory),
                after,
                target,
                input.editConstraints ?? {},
              ).length > 0;
          } finally {
            await services.workspaces.release(parentSpace.ref);
          }
          if (!changed)
            return {
              action: 'commit',
              status: 'no-change',
              candidateRef: parent.ref,
              diffRef: null,
            };
          const tree = fileTree(
            Object.fromEntries(
              Object.entries(after).map(([path, file]) => [
                path,
                Buffer.from(file.content, 'base64').toString('utf8'),
              ]),
            ),
          );
          const artifactRef = await services.artifacts.putJson(tree);
          if (artifactRef === parent.artifactRef)
            return {
              action: 'commit',
              status: 'no-change',
              candidateRef: parent.ref,
              diffRef: null,
            };
          return {
            action: 'commit',
            status: 'created',
            candidateRef: await context.recordCandidate(
              artifactRef,
              parent.ref,
            ),
            diffRef: await services.artifacts.putJson({ changed: true }),
          };
        }
        if (input.action === 'acquire') {
          return {
            action: 'acquire',
            instanceId: input.instanceId,
            execution: {},
          };
        }
        return {
          action: 'release',
          instanceId: input.instanceId,
          status: 'released',
        };
      },
      async dispose() {},
    };
  },
};

interface ScoreEntry {
  scores: Record<string, number | null>;
  error?: string;
  status?: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  comparisonKey?: string | null;
  itemComparisonKey?: string | null;
  metricMapping?: string;
  byTaskSet?: Record<string, ScoreEntry>;
  statuses?: Record<string, 'succeeded' | 'failed' | 'unknown'>;
  marker?: string;
  trajectoryPadding?: number;
}

function fakeMeasurementPlugin(
  calls: EvaluationCall[],
  scoreTable: Record<string, ScoreEntry>,
  paths: string[],
  afterMeasurement?: () => void,
): OperationDefinition<AgentbenchInput, AgentbenchOutput, JsonObject> {
  return {
    id: 'test.gepa-evaluator',
    contract: agentbenchContract,
    configSchema: { type: 'object' },
    async create(_config, services) {
      return {
        async execute(input, context) {
          const candidate = await context.readCandidate(input.candidateRef);
          const tree = object(
            await context.artifacts.readJson(candidate.artifactRef),
          );
          const files = decodeTree(tree);
          const key = paths.map((path) => files[path] ?? '').join('|');
          const originalEntry = scoreTable[key] ?? {
            scores: Object.fromEntries(
              input.taskIds.map((task: string) => [task, null]),
            ),
            status: 'unknown' as const,
          };
          const entry =
            originalEntry.byTaskSet?.[input.taskIds.slice().sort().join('|')] ??
            originalEntry;
          const status = entry.status ?? 'succeeded';
          calls.push({
            candidateRef: input.candidateRef,
            taskIds: [...input.taskIds],
            files,
          });
          await context.charge('evaluationRuns', 1);
          if (entry.error) throw new Error(entry.error);
          const emptyArtifact = (id: string) =>
            typedArtifact(
              id,
              { type: 'object' },
              // TypedArtifact needs a real artifact reference, not inline data.
              '',
            );
          void emptyArtifact;
          const provenance = typedArtifact(
            'test.gepa-provenance/v1',
            { type: 'object' },
            await services.artifacts.putJson({
              evaluator: 'deterministic-test',
              candidateRef: candidate.ref,
            }),
          );
          const conditions = typedArtifact(
            'test.gepa-conditions/v1',
            { type: 'object' },
            await services.artifacts.putJson({
              taskIds: input.taskIds,
              fixed: true,
            }),
          );
          const profile = typedArtifact(
            'test.gepa-profile/v1',
            { type: 'object' },
            await services.artifacts.putJson({ kind: 'controlled' }),
          );
          const definitionRef = await services.artifacts.putJson({
            id: 'score',
            description: 'Controlled per-task score',
            unit: 'ratio',
            valueKind: 'scalar',
            version: 1,
            aggregation: 'single point',
            mapping: entry.metricMapping ?? 'fixture',
          });
          const evidenceEntries = input.taskIds.map((task: string) => ({
            id: `trajectory-${task}`,
            kind: 'trajectory',
            artifactRef: null as string | null,
            mediaType: 'text/plain',
            sizeBytes: null,
            itemId: task,
            attemptId: null,
            access: 'execution',
            integrity: 'complete',
          }));
          const evidenceIndexRef = await services.artifacts.putJson({
            schemaVersion: 'rsi.measurement-evidence/v1',
            entries: evidenceEntries,
          });
          // Fill artifact references after creating the index fixture above.
          const catalog = object(
            await services.artifacts.readJson(evidenceIndexRef),
          );
          const withArtifacts = await Promise.all(
            (catalog.entries as unknown[]).map(async (raw) => {
              const item = object(raw);
              const task = string(item.itemId);
              item.artifactRef = await services.artifacts.putJson(
                fileTree({
                  'trajectory.jsonl': [
                    { role: 'user', content: `TASK_INPUT_MARKER ${task}` },
                    {
                      role: 'assistant',
                      content: `AGENT_OUTPUT_MARKER ${entry.marker ?? `output-${candidate.ref.slice(-6)}`}`,
                    },
                    ...Array.from(
                      { length: entry.trajectoryPadding ?? 0 },
                      (_, index) => ({
                        type: 'progress',
                        text: `Step ${index}: ${'execution detail '.repeat(8)}`,
                      }),
                    ),
                    { type: 'finished', text: `LATE_EXECUTION_MARKER ${task}` },
                  ]
                    .map((event) => JSON.stringify(event))
                    .join('\n'),
                }),
              );
              return item;
            }),
          );
          const finalEvidenceRef = await services.artifacts.putJson({
            schemaVersion: 'rsi.measurement-evidence/v1',
            entries: withArtifacts,
          });
          const items = await Promise.all(
            input.taskIds.map(async (task: string) => {
              const score = entry.scores[task] ?? null;
              const taskStatus = entry.statuses?.[task] ?? status;
              const available =
                typeof score === 'number' &&
                status === 'succeeded' &&
                taskStatus === 'succeeded';
              const metric = available
                ? {
                    definitionRef,
                    status: 'available' as const,
                    value: { kind: 'scalar' as const, value: score },
                    source: { artifactRef: finalEvidenceRef, pointer: '' },
                  }
                : {
                    definitionRef,
                    status: 'unavailable' as const,
                    value: null,
                    reason:
                      status === 'succeeded'
                        ? 'No valid scalar was produced'
                        : `Execution was ${status}`,
                    source: { artifactRef: finalEvidenceRef, pointer: '' },
                  };
              const feedback = {
                schemaVersion: 'rsi.evaluation-feedback/v1' as const,
                itemId: task,
                attemptId: null,
                executionStatus:
                  taskStatus === 'succeeded' ? 'completed' : taskStatus,
                scoreStatus: available
                  ? ('valid' as const)
                  : ('unknown' as const),
                passed: available ? score >= 0.5 : null,
                primaryReward: available ? 'score' : null,
                passThreshold: 0.5,
                checks: [
                  {
                    id: 'expected-output',
                    status: available ? 'pass' : 'unknown',
                    score,
                    reason:
                      'The expected output was observed in the execution evidence.',
                    source: { artifactRef: finalEvidenceRef, pointer: '' },
                  },
                ],
                checksComplete: true,
                diagnostics: [
                  {
                    kind: 'feedback',
                    code: null,
                    message: `feedback for ${task}`,
                    source: { artifactRef: finalEvidenceRef, pointer: '' },
                    truncated: false,
                  },
                ],
                truncated: false,
                source: { artifactRef: finalEvidenceRef, pointer: '' },
              };
              const evaluation = typedArtifact(
                'rsi.evaluation-feedback/v1',
                evaluationFeedbackSchema,
                await services.artifacts.putJson(feedback),
              );
              return {
                id: task,
                subject: { kind: 'task', id: task, parameters: null },
                status: taskStatus,
                coverage: taskStatus === 'succeeded' ? 'complete' : 'unknown',
                comparisonKey:
                  entry.itemComparisonKey === undefined
                    ? 'controlled'
                    : entry.itemComparisonKey,
                metrics: { score: metric },
                evaluation,
                evidenceIndexRef: finalEvidenceRef,
                details: provenance,
              };
            }),
          );
          const itemsRef = await services.artifacts.putJson({
            schemaVersion: 'rsi.measurement-items/v1',
            items,
          });
          const measurementRef = await context.recordMeasurement({
            schemaVersion: 'rsi.measurement/v1',
            ref: 'pending',
            experimentId: context.experimentId,
            callId: context.callId,
            candidateRef: candidate.ref,
            evaluator: {
              pluginId: 'test.gepa-evaluator',
              implementationDigest: 'deterministic-fixture',
            },
            startedAt: '2026-11-05T00:00:00Z',
            finishedAt: '2026-11-05T00:00:01Z',
            status,
            coverage: status === 'succeeded' ? 'complete' : 'unknown',
            comparisonKey:
              entry.comparisonKey === undefined
                ? 'controlled'
                : entry.comparisonKey,
            conditions,
            provenance,
            metrics: {},
            itemsRef,
            evidenceIndexRef: finalEvidenceRef,
            profile,
            diagnosticsRef: null,
            extensions: [],
          });
          afterMeasurement?.();
          return { measurementRef };
        },
        async dispose() {},
      };
    },
  };
}

function fakeAgentPlugin(
  calls: AgentCall[],
  proposals: Record<string, string | null>,
  modules: { id: string; path: string }[],
  reads: number,
  output?: JsonObject,
): OperationDefinition<AgentInput, AgentOutput, JsonObject> {
  return {
    id: 'test.gepa-agent',
    contract: agentContract,
    configSchema: { type: 'object' },
    async create() {
      return {
        async execute(input) {
          const payload = object(input.input ?? {});
          const constraints = object(payload.editConstraints);
          const pathsAllowed = constraints.allowedPaths;
          if (!Array.isArray(pathsAllowed) || pathsAllowed.length !== 1)
            throw new Error('GEPA mutation must authorize exactly one module');
          const pattern = string(pathsAllowed[0]);
          const module = modules.find((module) =>
            matchesGlob(module.path, pattern),
          );
          if (!module)
            throw new Error(`Unknown GEPA module pattern: ${pattern}`);
          const { id: moduleId, path } = module;
          const files = object(input.files ?? {});
          const paths = Object.keys(files).sort();
          const modelCalls = reads + 1;
          if (
            typeof input.maxModelCalls === 'number' &&
            modelCalls > input.maxModelCalls
          )
            throw new Error('controlled Agent model-call limit reached');
          for (let index = 0; index < reads; index++) {
            const path = paths[index % paths.length];
            if (path === undefined || typeof files[path] !== 'string')
              throw new Error(
                'controlled Agent read_file target is unavailable',
              );
          }
          calls.push({
            moduleId,
            maxModelCalls:
              typeof input.maxModelCalls === 'number'
                ? input.maxModelCalls
                : undefined,
            modelCalls,
            input: payload,
            files,
          });
          return (
            output ?? {
              edits:
                typeof proposals[moduleId] === 'string'
                  ? [{ path, content: proposals[moduleId] }]
                  : [],
              reason: 'controlled proposal',
            }
          );
        },
        async dispose() {},
      };
    },
  };
}

export async function runGepa(options: {
  seed: number;
  maxRounds: number;
  maxRollouts: number;
  minibatchSize?: number;
  paretoSize?: number;
  feedbackSampling?: 'random' | 'coverage-first';
  crossoverEvery?: number;
  feedbackTasks: string[];
  selectionTasks: string[];
  scoreTable: Record<string, ScoreEntry>;
  proposals: Record<string, string | null>;
  maxModelCalls?: number;
  reads?: number;
  agentOutput?: JsonObject;
  baselineFiles?: Record<string, string>;
  editConstraints?: JsonObject;
  modules?: { id: string; path: string }[];
  bindingNames?: { evaluator: string; proposer: string; agent: string };
  realAgentEndpoint?: string;
  resumeAfterEvaluation?: number;
  restartOnResume?: boolean;
  signal?: AbortSignal;
  onFailure?: (
    snapshot: JsonObject,
    calls: { evaluationCalls: EvaluationCall[]; agentCalls: AgentCall[] },
  ) => Promise<void>;
}): Promise<{
  output: JsonObject;
  evaluationCalls: EvaluationCall[];
  agentCalls: AgentCall[];
  manager: Manager;
  root: string;
  interrupted: JsonObject | null;
}> {
  const root = await mkdtemp(join(tmpdir(), 'rsi-gepa-runtime-'));
  const registry = new Registry();
  const evaluationCalls: EvaluationCall[] = [];
  const agentCalls: AgentCall[] = [];
  const interruption =
    options.resumeAfterEvaluation === undefined ? null : new AbortController();
  let manager = new Manager({ registry, rootDirectory: root });
  const baselineFiles = options.baselineFiles ?? { 'a.md': 'A0', 'b.md': 'B0' };
  const modules = options.modules ?? [
    { id: 'a', path: 'a.md' },
    { id: 'b', path: 'b.md' },
  ];
  registry.registerOperation(fakeApplication);
  registry.registerOperation(
    fakeMeasurementPlugin(
      evaluationCalls,
      options.scoreTable,
      Object.keys(baselineFiles),
      () => {
        if (
          interruption &&
          !interruption.signal.aborted &&
          evaluationCalls.length === options.resumeAfterEvaluation
        )
          interruption.abort(
            new Error('controlled GEPA checkpoint interruption'),
          );
      },
    ),
  );
  if (options.realAgentEndpoint) registry.registerOperation(piDefinition);
  else
    registry.registerOperation(
      fakeAgentPlugin(
        agentCalls,
        options.proposals,
        modules,
        options.reads ?? 0,
        options.agentOutput,
      ),
    );
  registry.registerOperation(promptEvolutionSearchDefinition);
  registry.registerOperation(proposerDefinition);
  const bindingNames = options.bindingNames ?? {
    evaluator: 'evaluator',
    proposer: 'proposer',
    agent: 'agent',
  };
  let policyId = 'policy.gepa';
  let policyPath = resolve('src/policies/gepa/policy.yaml');
  if (options.bindingNames) {
    const policy = object(await readPolicyDocument(policyPath));
    const requirements = object(policy.require);
    const defaultProposer = object(
      object(object(policy.defaults).bindings).proposer,
    );
    const proposerConfig = object(defaultProposer.config);
    policyId = 'policy.gepa-custom-routes';
    policy.id = policyId;
    policy.require = {
      search: requirements.search!,
      [bindingNames.evaluator]: requirements.evaluator!,
      [bindingNames.proposer]: requirements.proposer!,
      [bindingNames.agent]: requirements.agent!,
    };
    policy.defaults = {
      bindings: {
        search: {
          plugin: promptEvolutionSearchDefinition.id,
          config: {},
        },
        [bindingNames.proposer]: {
          ...defaultProposer,
          config: {
            ...proposerConfig,
            agentRef: bindingNames.agent,
            prompt: resolve('src/policies/gepa', string(proposerConfig.prompt)),
          },
        },
      },
    };
    const renameUses = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) renameUses(entry);
      } else if (value !== null && typeof value === 'object') {
        const entry = object(value);
        if (entry.use === 'evaluator') entry.use = bindingNames.evaluator;
        if (entry.use === 'proposer') entry.use = bindingNames.proposer;
        for (const child of Object.values(entry)) renameUses(child);
      }
    };
    renameUses(policy.steps);
    policyPath = join(root, 'custom-policy.yaml');
    await writeFile(policyPath, stringify(policy));
  }
  registry.registerPolicy(policyId, policyPath);
  const recipePath = join(root, 'recipe.yaml');
  await writeFile(
    recipePath,
    stringify({
      schemaVersion: 'rsi.recipe/v1',
      id: 'gepa-runtime-test',
      application: {
        plugin: fakeApplication.id,
        config: { files: baselineFiles },
      },
      policy: {
        id: policyId,
        input: { candidateRef: '${{ application.initialCandidate }}' },
        config: {
          dataset: {
            trainTaskIds: options.feedbackTasks,
            validationTaskIds: options.selectionTasks,
          },
        },
      },
      bindings: {
        search: {
          config: {
            maxRounds: options.maxRounds,
            maxRollouts: options.maxRollouts,
            minibatchSize: options.minibatchSize ?? 2,
            paretoSize: options.paretoSize ?? 2,
            ...(options.feedbackSampling
              ? { feedbackSampling: options.feedbackSampling }
              : {}),
            seed: options.seed,
            crossoverEvery: options.crossoverEvery ?? 3,
            modules,
            goal: 'Improve both modules.',
            ...(options.editConstraints
              ? { editConstraints: options.editConstraints }
              : {}),
          },
        },
        [bindingNames.evaluator]: { plugin: 'test.gepa-evaluator', config: {} },
        [bindingNames.proposer]: {
          config: { maxModelCalls: options.maxModelCalls ?? 12 },
        },
        [bindingNames.agent]: options.realAgentEndpoint
          ? {
              plugin: 'agent.pi',
              config: {
                model: 'fixture',
                base_url: options.realAgentEndpoint,
                api_key: '${GEPA_LOCAL_FIXTURE_KEY}',
                maxTokens: 4096,
                contextWindow: 32768,
                thinkingLevel: 'off',
                retries: 0,
                timeoutMs: 10000,
                executionTimeoutMs: 30000,
              },
            }
          : { plugin: 'test.gepa-agent', config: {} },
      },
      budget: {
        operations: 1000,
        evaluationRuns: 100,
        modelCalls: 1000,
        elapsedWallMs: 60000,
      },
    }),
  );
  let record: JsonObject;
  let interrupted: JsonObject | null = null;
  try {
    try {
      const signals = [options.signal, interruption?.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      );
      record = await manager.run(recipePath, {
        id: 'gepa-runtime',
        ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
      });
    } catch (error) {
      if (!interruption?.signal.aborted) throw error;
      interrupted = await manager.get('gepa-runtime');
      if (options.restartOnResume) {
        await manager.dispose();
        manager = new Manager({ registry, rootDirectory: root });
      }
      record = await manager.run(recipePath, {
        id: 'gepa-runtime',
        resume: true,
      });
    }
  } catch (error) {
    if (options.onFailure)
      await options.onFailure(await manager.get('gepa-runtime'), {
        evaluationCalls,
        agentCalls,
      });
    await manager.dispose();
    await registry.dispose();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    output: object(record.output),
    evaluationCalls,
    agentCalls,
    manager,
    root,
    interrupted,
  };
}
