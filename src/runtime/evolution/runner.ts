import { persistFact, PersistenceError } from '../storage/persistence-error.js';
import type {
  Binding,
  BudgetScope,
  FactStore,
  JsonObject,
  JsonValue,
  OperationDefinition,
  RuntimeContext,
} from '../../contracts/index.js';
import { digest, string } from '../../shared/json.js';
import { errorText } from '../../shared/errors.js';
import {
  collectEvolutionEvidence,
  type EvolutionEvidence,
} from './evidence.js';
import {
  isTerminal,
  readEvolutionRecord,
  readEvolutionResult,
  type RuntimeEvolutionResult,
  type RuntimeEvolutionStatus,
  type RuntimeEvolutionTerminalStatus,
} from './records.js';
import type { MemoryConfig, ReflectionConfig } from './validation.js';

export interface CycleOptions {
  config: MemoryConfig | ReflectionConfig;
  invocation: {
    policyScopeId: string;
    stepPath: string;
    triggerPath: string;
    attempt?: string;
  };
  priorAttempts?: readonly JsonObject[];
  context: RuntimeContext;
  directory: string;
  revisionRefs: Readonly<JsonObject>;
  bindings: Readonly<Record<string, Binding>>;
  getDefinition(id: string): OperationDefinition;
  callId?(binding: string, input: JsonValue, path: string): string;
  invoke(
    binding: string,
    input: JsonValue,
    key: string,
    scope: BudgetScope,
  ): Promise<JsonValue>;
}
export async function optionalFact(
  facts: FactStore,
  kind: string,
  id: string,
): Promise<JsonObject | null> {
  try {
    return await facts.read(kind, id);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}
export interface EvolutionCycle {
  identity: string;
  prior: JsonObject | null;
  assertScope(): void;
  save(status: RuntimeEvolutionStatus, data?: JsonObject): Promise<void>;
  finish(
    status: RuntimeEvolutionTerminalStatus,
    data?: JsonObject,
  ): Promise<RuntimeEvolutionResult>;
  evidence(): Promise<EvolutionEvidence>;
  invoke(input: JsonObject): Promise<JsonValue>;
}
interface EvolutionHandler {
  includes(record: JsonObject): Promise<boolean>;
  parentsMatch(record: JsonObject): boolean;
  execute(cycle: EvolutionCycle): Promise<RuntimeEvolutionResult>;
}
/** Own the durable invocation boundary. Only a validated proposal may publish an activation. */
export async function runEvolutionCycle(
  options: CycleOptions,
  kind: 'memory' | 'reflection',
  handler: EvolutionHandler,
): Promise<RuntimeEvolutionResult> {
  const { context, config, invocation } = options;
  context.signal.throwIfAborted();
  const { experimentId, facts } = context;
  const attempts = options.priorAttempts ?? [];
  for (const raw of attempts) {
    const record = readEvolutionRecord(raw);
    if (
      record.kind !== kind ||
      record.experimentId !== experimentId ||
      record.stepPath !== invocation.stepPath
    )
      throw new Error('Runtime evolution checkpoint ownership mismatch');
    if (isTerminal(record.status)) {
      const result = readEvolutionResult(
        record.result,
        string(record.evolutionId),
      );
      if (result.status !== record.status)
        throw new Error('Runtime evolution result status mismatch');
      return result;
    }
  }
  let replay: JsonObject | undefined;
  for (const record of attempts) {
    if (record.status === 'validated' && (await handler.includes(record))) {
      replay = record;
      break;
    }
    if (record.configDigest !== config.digest) continue;
    if (
      (record.status === 'prepared' || record.status === 'validated') &&
      !handler.parentsMatch(record)
    )
      continue;
    replay = record;
    break;
  }
  const identity = replay
    ? string(replay.evolutionId)
    : 'evolution-' + kind + '-' + digest({ experimentId, kind, ...invocation });
  const prior = await optionalFact(facts, 'evolution-runs', identity);
  const startedAt = prior ? string(prior.startedAt) : new Date().toISOString();
  if (prior) {
    const record = readEvolutionRecord(prior);
    if (
      record.kind !== kind ||
      record.experimentId !== experimentId ||
      record.stepPath !== invocation.stepPath ||
      (record.configDigest !== config.digest &&
        !(record.status === 'validated' && (await handler.includes(record))))
    )
      throw new Error(
        'Runtime evolution configuration or checkpoint is incompatible with this invocation',
      );
    if (isTerminal(record.status)) {
      const result = readEvolutionResult(record.result, identity);
      if (result.status !== record.status)
        throw new Error('Runtime evolution result status mismatch');
      return result;
    }
  }
  let persisted: JsonObject = prior ?? {
    evolutionId: identity,
    kind,
    experimentId,
    startedAt,
    policyScopeId: invocation.policyScopeId,
    stepPath: invocation.stepPath,
    triggerPath: invocation.triggerPath,
    configDigest: config.digest,
  };
  const save: EvolutionCycle['save'] = async (status, data = {}) => {
    const next = { ...persisted, ...data, status };
    await persistFact(facts, 'evolution-runs', identity, next);
    persisted = next;
  };
  const finish: EvolutionCycle['finish'] = async (status, data = {}) => {
    const result = readEvolutionResult({
      evolutionId: identity,
      status,
      reason: data.error ?? data.reason ?? status,
      revisionRefs: status === 'activated' ? (data.revisions ?? {}) : {},
      memoryRef: data.memoryRef ?? null,
    });
    await save(status, { ...data, result, reason: result.reason });
    return result;
  };
  const elapsed = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(elapsed))
    throw new Error('Invalid persisted runtime evolution start time');
  const wall = config.budget.elapsedWallMs;
  const timeout =
    wall === undefined
      ? undefined
      : AbortSignal.timeout(Math.max(0, wall - Math.max(0, elapsed)));
  const evidenceBytes = Math.min(
    config.budget.evidenceBytes ?? Infinity,
    context.scope?.limits.evidenceBytes ?? Infinity,
  );
  const scope: BudgetScope = {
    id: identity,
    signal: timeout
      ? AbortSignal.any([context.signal, timeout])
      : context.signal,
    limits: {
      ...config.budget,
      ...(Number.isFinite(evidenceBytes) ? { evidenceBytes } : {}),
    },
  };
  const assertScope = (): void => {
    context.signal.throwIfAborted();
    if (wall !== undefined && Date.now() - Date.parse(startedAt) >= wall)
      throw new Error('Runtime evolution local wall budget exhausted');
    scope.signal.throwIfAborted();
  };
  const cycle: EvolutionCycle = {
    identity,
    prior,
    assertScope,
    save,
    finish,
    async evidence() {
      assertScope();
      const evidence = await collectEvolutionEvidence({
        context: context.extend({ scope, signal: scope.signal }),
        kind,
        observe: config.observe,
        identity,
        capturedAt: startedAt,
        maxBytes: scope.limits.evidenceBytes,
        priorRef:
          typeof persisted.evidenceViewRef === 'string'
            ? persisted.evidenceViewRef
            : undefined,
        policyScopeId: invocation.policyScopeId,
        configDigest: config.digest,
        stepPath: invocation.stepPath,
        directory: options.directory,
        currentRevisionRefs: options.revisionRefs,
        view: config.evidenceView,
        isAgentBinding: (name) => {
          const binding = options.bindings[name];
          return (
            !!binding &&
            options.getDefinition(binding.plugin).contract.id ===
              'contract.agent'
          );
        },
      });
      if (!['prepared', 'validated'].includes(String(persisted.status)))
        await save('evidence-prepared', {
          evidenceViewRef: evidence.ref,
          callIds: evidence.callIds,
        });
      return evidence;
    },
    async invoke(input) {
      assertScope();
      if (config.plugin === kind + '.agent' && scope.limits.modelCalls === 0)
        throw new Error(kind + ' local model-call budget exhausted');
      const key = 'evolution/' + identity,
        binding = '_' + kind;
      if (options.callId)
        await save('prepared', { callId: options.callId(binding, input, key) });
      const output = await options.invoke(binding, input, key, scope);
      assertScope();
      return output;
    },
  };
  try {
    if (!prior) await save('started');
    return await handler.execute(cycle);
  } catch (error) {
    if (
      persisted.status === 'validated' &&
      (await handler.includes(persisted))
    ) {
      const result = await finish('activated', persisted);
      context.signal.throwIfAborted();
      return result;
    }
    context.signal.throwIfAborted();
    if (
      error instanceof PersistenceError ||
      (error instanceof Error && error.name === 'ExperimentBudgetExceeded')
    )
      throw error;
    return finish('rejected', { error: errorText(error) });
  }
}
