import { mkdir } from 'node:fs/promises';
import type {
  Binding,
  RuntimeContext,
  CallEventInfo,
  EventPipeline,
  FactStore,
  JsonObject,
  JsonValue,
  Operation,
} from '../../contracts/index.js';
import { object, digest, json } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { errorText } from '../../shared/errors.js';
import type { Registry } from '../registry/index.js';

interface CallExecutorOptions {
  id: string;
  registry: Registry;
  facts: FactStore;
  revisionRefs: JsonObject;
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
  (
    binding: string,
    input: JsonValue,
    context: RuntimeContext,
    path?: string,
    parallel?: boolean,
  ): Promise<JsonValue>;
  readonly pending: number;
  close(): void;
  idle(): Promise<void>;
  unconfirmed(): Promise<void>;
}

export function createCallExecutor(options: CallExecutorOptions): CallExecutor {
  const { id, context, revisionRefs, charge } = options;
  const active = new Map<string, Promise<JsonValue>>();
  const pending = new Set<Promise<JsonValue>>();
  const uncertain = new Map<string, () => Promise<void>>();
  const childFailures = new Map<string, unknown>();
  let accepting = true;
  const invoke = async (
    bindingId: string,
    input: JsonValue,
    caller: RuntimeContext,
    path?: string,
    _parallel = false,
  ): Promise<JsonValue> => {
    // Admission and registration run without an await, including for old contexts.
    if (!accepting)
      throw new Error('Experiment no longer accepts business calls');
    if (caller.experimentId !== id)
      throw new Error('Call belongs to another experiment');
    const callId =
      'call-' +
      digest({
        experiment: id,
        bindingId,
        path: path ?? caller.callId,
        input,
      }).slice(0, 32);
    const existing = active.get(callId);
    if (existing) return existing;
    const job = (async (): Promise<JsonValue> => {
      let ctx = context(bindingId, callId, caller);
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
      if (prior?.status === 'succeeded') return prior.output;
      ctx.signal.throwIfAborted();
      const binding = options.binding(bindingId);
      if (!binding) throw new Error(`Unknown binding ${bindingId}`);
      const revisionRef = revisionRefs[bindingId];
      const info: CallEventInfo = {
        experimentId: id,
        callId,
        bindingId,
        path: path ?? caller.callId,
        parentCallId: caller.callId,
        bindingRef: binding.plugin,
        revisionRef: typeof revisionRef === 'string' ? revisionRef : null,
      };
      const definition = options.registry.get(binding.plugin);
      validate(definition.contract.input_schema, input, `${bindingId} input`);
      const lease = await options.operation(bindingId, binding);
      ctx = ctx.extend({ event: lease.event });
      try {
        if (
          prior &&
          ((prior.status !== 'failed' && prior.status !== 'cancelled') ||
            prior.pluginId !== binding.plugin ||
            !lease?.operation.canRetry ||
            (await lease.operation.canRetry(input, prior, ctx)) !== true)
        ) {
          throw new Error(
            `Call ${callId} has unconfirmed/failed effects; inspect its receipt before recovery`,
          );
        }
        ctx.signal.throwIfAborted();
        await charge('operations', 1, ctx);
        await mkdir(ctx.directory, { recursive: true });
        const recoveredFrom = prior
          ? `${callId}-${digest(prior).slice(0, 24)}`
          : null;
        if (prior && recoveredFrom)
          await options.facts.write('call-attempts', recoveredFrom, prior);
        const receipt: JsonObject = {
          ...info,
          pluginId: binding.plugin,
          status: 'running',
          input,
          startedAt: new Date().toISOString(),
          ...(recoveredFrom ? { recoveredFrom } : {}),
        };
        await options.facts.write('calls', callId, receipt);
        let committed = false;
        // Serialize final receipts with any late settlement after a cleanup timeout.
        let writes = Promise.resolve();
        const commit = (value: JsonObject): Promise<boolean> => {
          const write = writes.then(async () => {
            if (committed) return false;
            await options.facts.write('calls', callId, {
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
        let output: JsonValue;
        try {
          const decision = await ctx.event.waterfall(
            'rsi/before-call',
            { ...info, status: 'running' },
            async () => ({ kind: 'proceed' }),
          );
          ctx.signal.throwIfAborted();
          if (
            !decision ||
            typeof decision !== 'object' ||
            (decision.kind !== 'proceed' && decision.kind !== 'reject') ||
            (decision.kind === 'reject' &&
              (typeof decision.reason !== 'string' || !decision.reason.trim()))
          )
            throw new Error('Invalid rsi/before-call decision');
          if (decision.kind === 'reject')
            throw new Error(`Call admission rejected: ${decision.reason}`);
          output = await lease.operation.execute(input, ctx);
          json(output);
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
          if (!(await commit({ status: 'succeeded', output })))
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
                  (ctx.signal.aborted &&
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
        }
        // A result listener failure must not rewrite a committed successful receipt.
        try {
          await ctx.event.parallel('rsi/call-succeeded', {
            ...info,
            status: 'succeeded',
            ...(output &&
            typeof output === 'object' &&
            !Array.isArray(output) &&
            typeof output.measurementRef === 'string'
              ? { measurementRef: output.measurementRef }
              : {}),
          });
        } catch (error) {
          throw new Error('Event handling failed: rsi/call-succeeded', {
            cause: error,
          });
        }
        return output;
      } finally {
        lease.release();
      }
    })();
    const supervised = job.catch((error) => {
      options.onFailure(error, caller);
      throw error;
    });
    active.set(callId, supervised);
    pending.add(supervised);
    void supervised.finally(() => pending.delete(supervised)).catch(() => {});
    return supervised;
  };
  const executor = Object.assign(invoke, {
    get pending() {
      return pending.size;
    },
    close() {
      accepting = false;
    },
    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    async unconfirmed() {
      await Promise.allSettled([...uncertain.values()].map((mark) => mark()));
    },
  });
  Object.defineProperty(executor, 'pending', { get: () => pending.size });
  return executor;
}
