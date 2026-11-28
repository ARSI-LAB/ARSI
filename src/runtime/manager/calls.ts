import { persistFact } from '../storage/persistence-error.js';
import { OperationRejectedError } from '../../contracts/runtime/errors.js';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { getLogger } from '@logtape/logtape';
import { agentContract } from '../../contracts/index.js';
import { metricSelectorContract } from '../../contracts/plugin-types/selector-metrics.js';
import { assertOwnedAgentProject } from '../../shared/agent-project.js';
import { pinnedMemory } from '../evolution/memory-delivery.js';
import type { ActiveMemory } from '../evolution/memory.js';
import type {
  Binding,
  RuntimeContext,
  CallDecision,
  CallEventInfo,
  EventPipeline,
  FactStore,
  JsonObject,
  JsonValue,
  Operation,
  OperationDefinition,
} from '../../contracts/index.js';
import { object, digest, json } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { errorText } from '../../shared/errors.js';
import {
  callLabel,
  formatDuration,
  selectionLogDetails,
} from '../../shared/call-log.js';
import type { Registry } from '../registry/index.js';
import { agentReplayKey } from './retry.js';

const logger = getLogger(['arsi', 'runtime', 'manager']);

interface CallExecutorOptions {
  id: string;
  registry: Registry;
  facts: FactStore;
  revisionRefs: Readonly<JsonObject>;
  memoryForBinding?(bindingId: string): ActiveMemory | null;
  retryCalls?: ReadonlyMap<string, JsonObject>;
  retryRef?: string;
  onReusedCall?(receipt: JsonObject): void;
  context(binding: string, id: string, parent: RuntimeContext): RuntimeContext;
  binding(name: string): Binding | undefined;
  operation(
    bindingId: string,
    binding: Binding,
  ): Promise<{ operation: Operation; event: EventPipeline; release(): void }>;
  charge(
    metric: string,
    amount: number,
    context: RuntimeContext,
  ): Promise<void>;
  diagnose(event: string, error: unknown): void;
  onFailure(error: unknown, context: RuntimeContext): void;
}
export interface CallExecutor {
  invoke(
    binding: string,
    input: JsonValue,
    context: RuntimeContext,
    path?: string,
    metadata?: JsonObject,
  ): Promise<JsonValue>;
  readonly pending: number;
  close(): void;
  idle(): Promise<void>;
  unconfirmed(): Promise<void>;
}

/** Validate the final decision from potentially untyped plugin listeners. */
export function assertCallAdmitted<T extends CallDecision>(
  decision: T,
): asserts decision is Extract<T, { kind: 'proceed' }> {
  if (
    !decision ||
    (decision.kind !== 'proceed' && decision.kind !== 'reject') ||
    (decision.kind === 'reject' &&
      (typeof decision.reason !== 'string' || !decision.reason.trim()))
  )
    throw new Error('Invalid call admission decision');
  if (decision.kind === 'reject')
    throw new Error(`Call admission rejected: ${decision.reason}`);
  if (decision.metadata !== undefined)
    object(decision.metadata, 'Call admission metadata');
}

export function callIdentity(
  experiment: string,
  bindingId: string,
  path: string,
  input: JsonValue,
  attempt?: string,
): string {
  return (
    'call-' +
    digest({
      experiment,
      bindingId,
      path,
      input,
      ...(attempt ? { attempt } : {}),
    }).slice(0, 32)
  );
}

export function createCallExecutor(options: CallExecutorOptions): CallExecutor {
  const { id, context, charge } = options;
  const facts = options.facts;
  const evolutionFacts: FactStore = {
    read: facts.read.bind(facts),
    list: facts.list.bind(facts),
    ...(facts.scan ? { scan: facts.scan.bind(facts) } : {}),
    async write(kind, key, value) {
      if (kind === 'candidates')
        throw new Error(
          'Runtime evolution calls cannot write Application candidates',
        );
      await persistFact(facts, kind, key, value);
    },
  };
  const active = new Map<string, Promise<JsonValue>>();
  const uncertain = new Map<string, () => Promise<void>>();
  const childFailures = new Map<string, unknown>();
  const optionalCalls = new Set<string>();
  let accepting = true;
  const invoke = async (
    bindingId: string,
    input: JsonValue,
    caller: RuntimeContext,
    path?: string,
    metadata?: JsonObject,
  ): Promise<JsonValue> => {
    // Admission and registration run without an await, including for old contexts.
    if (!accepting)
      throw new Error('Experiment no longer accepts business calls');
    if (caller.experimentId !== id)
      throw new Error('Call belongs to another experiment');
    let definition: OperationDefinition;
    let agentInput: JsonObject | undefined;
    let project: string | undefined;
    try {
      const selected = options.binding(bindingId);
      if (!selected) throw new Error(`Unknown binding ${bindingId}`);
      definition = options.registry.get(selected.plugin);
      json(input);
      input = structuredClone(input);
      if (metadata !== undefined) metadata = structuredClone(metadata);
      validate(definition.contract.input_schema, input, `${bindingId} input`);
      if (
        optionalCalls.has(caller.callId) &&
        definition.contract.id === 'contract.application' &&
        ['commit', 'initialize'].includes(String(object(input).action))
      )
        throw new Error(
          'Runtime evolution calls cannot create Application candidates',
        );
      agentInput =
        definition.contract.id === agentContract.id ? object(input) : undefined;
      project =
        typeof agentInput?.cwd === 'string' ? agentInput.cwd : undefined;
      if (project !== undefined) {
        if (caller.agentProject === undefined) {
          const hash = basename(dirname(project));
          const projects = join(resolve(caller.directory), 'agent-projects');
          if (
            !isAbsolute(project) ||
            project !== join(projects, hash, 'project') ||
            !/^[a-f0-9]{64}$/.test(hash) ||
            agentInput?.role !== undefined
          )
            throw new Error(
              'Agent cwd must be a prepared project owned by this call',
            );
        } else if (
          project !== caller.agentProject ||
          agentInput?.role === undefined
        )
          throw new Error(
            'Agent delegates must use a named role in their parent project',
          );
      }
    } catch (error) {
      options.onFailure(error, caller);
      throw error;
    }
    const preparedAgent =
      agentInput !== undefined &&
      project !== undefined &&
      caller.agentProject === undefined &&
      agentInput.role === undefined
        ? agentReplayKey(
            bindingId,
            caller.callId,
            path ?? caller.callId,
            agentInput,
            `artifact:${basename(dirname(project))}`,
          )
        : undefined;
    const policyReceipt =
      caller.callId === 'root' && path !== undefined
        ? options.retryCalls?.get(path)
        : preparedAgent
          ? options.retryCalls?.get(preparedAgent)
          : undefined;
    const callId =
      typeof policyReceipt?.callId === 'string'
        ? policyReceipt.callId
        : callIdentity(
            id,
            bindingId,
            path ?? caller.callId,
            input,
            bindingId === '_application' &&
              ['acquire', 'release'].includes(String(object(input).action)) &&
              caller.idempotencyKey !== caller.callId
              ? caller.idempotencyKey
              : undefined,
          );
    const existing = active.get(callId);
    if (existing) return existing;
    const checkedOutput = (value: unknown): JsonValue => {
      json(value);
      const output = structuredClone(value);
      validate(
        definition.contract.output_schema,
        output,
        `${bindingId} output`,
      );
      if (
        bindingId === '_application' &&
        object(input).action !== object(output).action
      )
        throw new Error('Application returned wrong action');
      return output;
    };
    const evolutionCall =
      bindingId === '_memory' ||
      bindingId === '_reflection' ||
      optionalCalls.has(caller.callId);
    const memory = evolutionCall
      ? null
      : (options.memoryForBinding?.(bindingId) ?? null);
    const job = (async (): Promise<JsonValue> => {
      let ctx: RuntimeContext = context(bindingId, callId, caller).extend({
        [pinnedMemory]: memory,
      });
      let projectArtifactRef: string | undefined;
      if (project !== undefined) {
        if (caller.agentProject === undefined) {
          const hash = basename(dirname(project));
          await assertOwnedAgentProject(caller.directory, project);
          projectArtifactRef = `artifact:${hash}`;
        }
        ctx = ctx.extend({ agentProject: project });
      }

      let prior: JsonObject | undefined;
      try {
        prior = await options.facts.read('calls', callId);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
      }
      const reportReuse =
        options.onReusedCall &&
        caller.callId === 'root' &&
        (path === 'initialize' || path?.startsWith('steps/'))
          ? options.onReusedCall
          : undefined;
      if (prior?.status === 'succeeded') {
        const output = checkedOutput(prior.output);
        reportReuse?.(prior);
        return output;
      }
      ctx.signal.throwIfAborted();
      // Receipt recovery does not reserve a version; pin it together with its lease.
      const binding = options.binding(bindingId);
      if (!binding) throw new Error(`Unknown binding ${bindingId}`);
      const revisionRef = options.revisionRefs[bindingId];
      const info: CallEventInfo = {
        experimentId: id,
        callId,
        bindingId,
        path: path ?? caller.callId,
        parentCallId: caller.callId,
        bindingRef: binding.plugin,
        revisionRef: typeof revisionRef === 'string' ? revisionRef : null,
      };
      if (evolutionCall) {
        optionalCalls.add(callId);
        ctx = ctx.extend({
          facts: evolutionFacts,
          async recordCandidate() {
            throw new Error(
              'Runtime evolution calls cannot create Application candidates',
            );
          },
        });
      }
      const lease = await options.operation(bindingId, binding);
      ctx = ctx.extend({ event: lease.event });
      const freshAttempt =
        prior && options.retryRef && options.retryRef !== prior.retryRef;
      try {
        if (
          prior &&
          (!freshAttempt ||
            !['failed', 'cancelled', 'unknown', 'running'].includes(
              String(prior.status),
            ))
        ) {
          throw new Error(`Call ${callId} requires a new resume attempt`);
        }
        ctx.signal.throwIfAborted();
        const attemptId = prior ? digest(prior).slice(0, 24) : undefined;
        const recoveredFrom = attemptId ? `${callId}-${attemptId}` : null;
        if (attemptId && recoveredFrom) {
          ctx = ctx.extend({
            idempotencyKey: recoveredFrom,
            directory: join(ctx.directory, 'attempts', attemptId),
          });
        }
        await charge('operations', 1, ctx);
        await mkdir(ctx.directory, { recursive: true });
        if (prior && recoveredFrom)
          await persistFact(
            options.facts,
            'call-attempts',
            recoveredFrom,
            prior,
          );
        const receipt: JsonObject = {
          ...info,
          pluginId: binding.plugin,
          contractId: definition.contract.id,
          status: 'running',
          input,
          ...(metadata === undefined ? {} : { metadata }),
          ...(projectArtifactRef === undefined
            ? {}
            : { agentProjectArtifactRef: projectArtifactRef }),
          startedAt: new Date().toISOString(),
          ...(recoveredFrom ? { recoveredFrom } : {}),
          ...(options.retryRef ? { retryRef: options.retryRef } : {}),
          ...(attemptId ? { attemptId } : {}),
        };
        await persistFact(options.facts, 'calls', callId, receipt);
        const applicationAction =
          bindingId === '_application' ? object(input).action : undefined;
        const label = callLabel(bindingId, path, applicationAction);
        const activeTask = {
          id: callId,
          label,
          parentId: caller.callId === 'root' ? undefined : caller.callId,
        };
        const finishedTask = { ...activeTask, done: true };
        const start = performance.now();
        const timing = () => {
          const durationMs = performance.now() - start;
          return { durationMs, duration: formatDuration(durationMs) };
        };
        logger.debug('Running {label}', { ...info, label, activeTask });
        let committed = false;
        // Serialize final receipts with any late settlement after a cleanup timeout.
        let writes = Promise.resolve();
        const commit = (value: JsonObject): Promise<boolean> => {
          const write = writes.then(async () => {
            if (committed) return false;
            await persistFact(options.facts, 'calls', callId, {
              ...receipt,
              ...value,
              finishedAt: new Date().toISOString(),
            });
            committed = true;
            return true;
          });
          writes = write.then(
            () => {},
            () => {},
          );
          return write;
        };
        uncertain.set(callId, async () => {
          if (
            await commit({
              status: 'unknown',
              error: 'Business work did not settle before cleanup deadline',
            })
          ) {
            logger.error('{label} {duration}: Outcome unconfirmed', {
              ...info,
              label,
              stage: 'Failed',
              status: 'unknown',
              activeTask: finishedTask,
              ...timing(),
            });
            try {
              void ctx.event
                .parallel('rsi/call-unknown', { ...info, status: 'unknown' })
                .catch((error: unknown) =>
                  options.diagnose('rsi/call-unknown', error),
                );
            } catch (error) {
              options.diagnose('rsi/call-unknown', error);
            }
          }
        });
        const parentSignal = ctx.signal;
        let output: JsonValue;
        try {
          const decision = await ctx.event.waterfall(
            'rsi/before-call',
            { ...info, status: 'running' },
            async () => ({ kind: 'proceed' }),
          );
          ctx.signal.throwIfAborted();
          assertCallAdmitted(decision);
          if (decision.metadata !== undefined) {
            const admitted = structuredClone(decision.metadata);
            const write = writes.then(async () => {
              if (committed)
                throw new Error(`Call ${callId} outcome remains unconfirmed`);
              // Agent preparation owns the provenance of the submitted input.
              receipt.metadata = { ...admitted, ...metadata };
              await persistFact(options.facts, 'calls', callId, receipt);
            });
            writes = write.then(
              () => {},
              () => {},
            );
            await write;
          }
          output = checkedOutput(await lease.operation.execute(input, ctx));
          if (ctx.scope) ctx.signal.throwIfAborted();
          if (
            !(await commit({
              status: 'succeeded',
              output,
            }))
          )
            throw new Error(`Call ${callId} outcome remains unconfirmed`);
        } catch (error) {
          const explicit =
            error && typeof error === 'object' && 'status' in error
              ? error.status
              : undefined;
          const status =
            explicit === 'unknown'
              ? 'unknown'
              : explicit === 'cancelled' ||
                  (parentSignal.aborted &&
                    !(
                      childFailures.has(callId) &&
                      childFailures.get(callId) === error
                    ))
                ? 'cancelled'
                : 'failed';
          if (
            await commit({
              status,
              error: errorText(error),
              measurementRef:
                error && typeof error === 'object' && 'measurementRef' in error
                  ? String(error.measurementRef)
                  : null,
            })
          ) {
            const details = {
              ...info,
              label,
              status,
              error,
              activeTask: finishedTask,
              ...timing(),
            };
            if (status === 'cancelled')
              logger.warn('{label} {duration}', {
                ...details,
                stage: 'Cancelled',
              });
            else
              logger.error('{label} {duration}', {
                ...details,
                stage: 'Failed',
              });
            // Preserve a failure as it propagates through its owning calls,
            // even after supervision has cancelled the other branches.
            if (status === 'failed' && uncertain.has(caller.callId))
              childFailures.set(caller.callId, error);
            try {
              if (status === 'cancelled')
                await ctx.event.parallel('rsi/call-cancelled', {
                  ...info,
                  status,
                });
              else if (status === 'unknown')
                await ctx.event.parallel('rsi/call-unknown', {
                  ...info,
                  status,
                });
              else
                await ctx.event.parallel('rsi/call-failed', {
                  ...info,
                  status,
                });
            } catch (notificationError) {
              options.diagnose(`rsi/call-${status}`, notificationError);
            }
          }
          throw error;
        } finally {
          childFailures.delete(callId);
          uncertain.delete(callId);
          logger.trace('Settled {label}', {
            ...info,
            label,
            activeTask: finishedTask,
          });
        }
        const completion = {
          ...info,
          label,
          activeTask: finishedTask,
          ...timing(),
        };
        const refs =
          output && typeof output === 'object' && !Array.isArray(output)
            ? output
            : undefined;
        const candidateRef = refs?.candidateRef ?? refs?.initialCandidateRef;
        const measurementRef = refs?.measurementRef;
        const reference =
          typeof candidateRef === 'string'
            ? ` · candidate ${candidateRef}`
            : typeof measurementRef === 'string'
              ? ` · measurement ${measurementRef}`
              : '';
        logger.info('{label} {duration}{reference}', {
          ...completion,
          stage: 'Completed',
          candidateRef,
          measurementRef,
          reference,
          applicationAction,
          ...(definition.contract.id === metricSelectorContract.id
            ? { selection: selectionLogDetails(output) }
            : {}),
        });
        // Notification errors do not undo a settled optional update.
        const eventName = 'rsi/call-succeeded';
        try {
          await ctx.event.parallel(eventName, {
            ...info,
            status: 'succeeded',
            ...(typeof measurementRef === 'string' ? { measurementRef } : {}),
          });
        } catch (error) {
          if (optionalCalls.has(callId)) options.diagnose(eventName, error);
          else
            throw new Error(`Event handling failed: ${eventName}`, {
              cause: error,
            });
        }
        return output;
      } finally {
        lease.release();
      }
    })();
    const supervised = job.catch((error) => {
      if (
        !optionalCalls.has(callId) &&
        !(error instanceof OperationRejectedError && active.has(caller.callId))
      )
        options.onFailure(error, caller);
      throw error;
    });
    active.set(callId, supervised);
    void supervised
      .finally(() => {
        active.delete(callId);
      })
      .catch(() => {});
    return supervised;
  };
  return {
    invoke,
    get pending() {
      return active.size;
    },
    close() {
      accepting = false;
    },
    async idle() {
      while (active.size) await Promise.allSettled([...active.values()]);
    },
    async unconfirmed() {
      await Promise.allSettled([...uncertain.values()].map((mark) => mark()));
    },
  };
}
