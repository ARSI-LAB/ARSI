import { tmpdir } from 'node:os';
import { mkdir, mkdtempDisposable } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { lock } from 'proper-lockfile';
import type {
  CleanupContext,
  CleanupResult,
  FactStore,
  JsonObject,
  JsonValue,
  JsonSchema,
  RuntimeContext,
} from '../../contracts/index.js';
import { errorText, redactConfiguration } from '../../shared/errors.js';
import { json, object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import type { Registry } from '../registry/index.js';
import { acquireResourceGate } from '../revisions/exclusion.js';
import type { ManagedEvents } from '../services/events.js';
import { safeId } from '../storage/index.js';
import {
  assertDefinitionDigest,
  definitionArchiveId,
} from './definition-lock.js';
import { acquireExecutionLock } from './execution-lock.js';
import type { Manager } from './index.js';
import { type Instances, withBindingInstance } from './instances.js';
import {
  experimentCleanupState,
  readExperimentCleanupState,
  readExperimentRecord,
} from './records.js';

type CleanupState = 'idle' | 'pending' | 'failed' | 'released';

/** Retains ownership after a deadline or failed external disposal until settlement/reconciliation. */
export class CleanupLifecycle {
  private state: CleanupState = 'idle';
  private job: Promise<void> = Promise.resolve();
  private deadline: number | undefined;
  private reconciling: Promise<void> | undefined;
  private readonly externalFailures: unknown[] = [];
  private marking: Promise<void> | undefined;
  private settled = false;
  private lockReleasedAfterFailure = false;
  private retryPreparation: (() => Promise<void>) | undefined;
  private readonly unboundedSignal = new AbortController().signal;
  constructor(
    readonly id: string,
    private readonly reserveMs: number | undefined,
    private readonly facts: FactStore,
    private readonly events: ManagedEvents,
    private readonly instances: Instances,
    private readonly releaseResources: () => Promise<void>,
  ) {}

  get released(): boolean {
    return this.state === 'released';
  }

  get relinquished(): boolean {
    return this.lockReleasedAfterFailure;
  }
  get signal(): AbortSignal {
    if (this.reserveMs === undefined) return this.unboundedSignal;
    return AbortSignal.timeout(
      Math.max(
        1,
        this.deadline === undefined
          ? this.reserveMs
          : this.deadline - Date.now(),
      ),
    );
  }

  async within<T>(job: Promise<T>): Promise<T> {
    if (this.reserveMs === undefined) return job;
    this.deadline ??= Date.now() + this.reserveMs;
    return this.bounded(job, Math.max(0, this.deadline - Date.now()));
  }

  private async bounded<T>(
    job: Promise<T>,
    milliseconds: number | undefined,
  ): Promise<T> {
    if (milliseconds === undefined) return job;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        job,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'Cleanup deadline exceeded; cleanup is still pending',
                ),
              ),
            milliseconds,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async record(error: unknown, cleanupId = this.id): Promise<void> {
    await this.facts.write('cleanup', cleanupId, {
      experimentId: this.id,
      status: this.state === 'failed' ? 'failed' : 'unconfirmed',
      error: errorText(error),
    });
  }

  /** Establish durable unresolved ownership before terminal publication or external disposal. */
  markPending(): Promise<void> {
    if (this.marking) return this.marking;
    const job = this.facts.write('cleanup', this.id, {
      experimentId: this.id,
      status: 'unconfirmed',
      startedAt: new Date().toISOString(),
    });
    this.marking = job;
    void job.catch(() => {
      if (this.marking === job) this.marking = undefined;
    });
    return job;
  }

  /** A settled cleanup call failed; ownership remains until the caller reconciles its effects. */
  async externalFailure(error: unknown, cleanupId: string): Promise<void> {
    this.externalFailures.push(error);
    await this.record(error, cleanupId);
  }

  retire(
    instance: Awaited<ReturnType<Instances['prepare']>>,
    cleanupId: string,
  ): void {
    const job = this.markPending().then(() => this.instances.dispose(instance));
    const timer =
      this.reserveMs === undefined
        ? undefined
        : setTimeout(() => {
            const error = new Error('Instance cleanup deadline exceeded');
            this.events.abort(instance.scope, error);
            void this.record(error, cleanupId).catch(() => {});
          }, this.reserveMs);
    void job
      .catch((error: unknown) => this.record(error, cleanupId))
      .finally(() => clearTimeout(timer))
      .catch(() => {});
  }

  start(
    drain: () => Promise<void>,
    notification: Promise<unknown>,
    diagnostics: () => Promise<unknown>,
    releaseOnFailure = false,
  ): Promise<void> {
    if (this.state !== 'idle') throw new Error('Cleanup already started');
    const work = async (): Promise<void> => {
      await this.markPending();
      // Only durable-marker failure is safe to retry; no disposal has begun here.
      this.retryPreparation = undefined;
      const errors: unknown[] = [];
      try {
        await notification;
      } catch (error) {
        errors.push(error);
      }
      await drain();
      // Disposal settles every instance independently before propagating errors.
      let disposalError: unknown;
      let failed = false;
      try {
        await this.instances.disposeAll();
      } catch (error) {
        failed = true;
        disposalError = error;
      }
      await diagnostics();
      if (failed) errors.push(disposalError);
      errors.push(...this.externalFailures);
      if (errors.length) {
        const failure = new AggregateError(errors, 'Experiment cleanup failed');
        if (releaseOnFailure) {
          this.state = 'failed';
          await this.record(failure);
          await this.events.dispose();
          await this.releaseResources();
          this.lockReleasedAfterFailure = true;
        }
        throw failure;
      }
      await this.finish();
    };
    this.retryPreparation = work;
    return this.attempt(work);
  }

  private attempt(work: () => Promise<void>): Promise<void> {
    this.state = 'pending';
    this.settled = false;
    this.job = work()
      .catch(async (error: unknown) => {
        this.state = 'failed';
        if (!this.relinquished) await this.record(error);
        throw error;
      })
      .finally(() => {
        this.settled = true;
      });
    void this.job.catch(() => {});
    return this.job;
  }

  /** Retry only failed preparation before disposal; otherwise observe the original effects. */
  async observe(): Promise<void> {
    if (this.settled && this.state === 'failed' && this.retryPreparation) {
      this.deadline =
        this.reserveMs === undefined ? undefined : Date.now() + this.reserveMs;
      this.attempt(this.retryPreparation);
    }
    await this.bounded(this.job, this.reserveMs);
  }

  /** Caller confirms all failed external disposals have been reconciled outside Runtime. */
  reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    const job = (async () => {
      if (!this.settled || this.state === 'pending' || this.state === 'idle')
        throw new Error('Experiment cleanup is still pending');
      if (this.state === 'released') return;
      this.instances.reconcileFailures();
      await this.finish('reconciled');
    })();
    this.reconciling = job;
    void job.catch(() => {
      if (this.reconciling === job) this.reconciling = undefined;
    });
    return job;
  }

  private async finish(
    status: 'succeeded' | 'reconciled' = 'succeeded',
  ): Promise<void> {
    await this.events.dispose();
    let previous;
    try {
      previous = await this.facts.read('cleanup', this.id);
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
    if (previous || status === 'reconciled')
      await this.facts.write('cleanup', this.id, {
        ...previous,
        experimentId: this.id,
        status,
        finishedAt: new Date().toISOString(),
      });
    await this.releaseResources();
    this.state = 'released';
  }
}

/** Preserve the previous cleanup outcome before the new attempt publishes its own. */
export async function archiveUnresolvedCleanup(
  facts: FactStore,
  id: string,
  archiveId: string,
): Promise<void> {
  let cleanup;
  try {
    cleanup = await facts.read('cleanup', id);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  }
  const state = experimentCleanupState(cleanup, id);
  if (state === 'invalid')
    throw new Error('Invalid cleanup ownership or unsupported cleanup status');
  if (state === 'unresolved')
    await facts.write('cleanup-attempts', archiveId, cleanup);
}

/** Explicitly confirm external cleanup after establishing exclusive ownership, preserving business status.
 * A crash may leave a running or absent experiment record between cleanup marking and terminal publication.
 */
export async function reconcilePersistedCleanup(
  id: string,
  directory: string,
  facts: FactStore,
): Promise<void> {
  const gate = await acquireResourceGate(directory);
  let release: (() => Promise<void>) | undefined;
  let compromised: Error | undefined;
  try {
    const path = join(directory, 'locks', id);
    await mkdir(dirname(path), { recursive: true });
    gate.assertOwned();
    release = await lock(path, {
      realpath: false,
      stale: 60000,
      update: 10000,
      retries: 0,
      onCompromised(error) {
        compromised = error;
      },
    });
    let cleanup;
    try {
      cleanup = await facts.read('cleanup', id);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return;
      throw error;
    }
    const state = experimentCleanupState(cleanup, id);
    if (state === 'invalid')
      throw new Error(
        'Invalid cleanup ownership or unsupported cleanup status',
      );
    if (state === 'resolved') return;
    try {
      readExperimentRecord(await facts.read('experiments', id));
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
    gate.assertOwned();
    if (compromised) throw compromised;
    await facts.write('cleanup', id, {
      ...cleanup,
      status: 'reconciled',
      reconciledAt: new Date().toISOString(),
    });
  } finally {
    try {
      await release?.();
    } finally {
      await gate.release();
    }
  }
}

/** Call under the experiment lock before loading/restoring or returning persisted business results. */
export async function assertCleanupResolved(
  facts: FactStore,
  id: string,
): Promise<void> {
  const state = await readExperimentCleanupState(facts, id);
  if (state === 'invalid')
    throw new Error('Invalid cleanup ownership or unsupported cleanup status');
  if (state === 'unresolved')
    throw new Error(
      `Experiment ${id} cleanup is unresolved; reconcileCleanup before resuming`,
    );
}

type CleanupBinding = Pick<CleanupContext, 'bindingId' | 'pluginId'>;
export type BindingCleanupResult = CleanupResult & CleanupBinding;
type ExperimentCleanupContext = Omit<CleanupContext, keyof CleanupBinding>;

export type CleanupBindingProgress =
  | {
      readonly kind: 'bindings-discovered';
      readonly experimentId: string;
      readonly totalBindings: number;
    }
  | {
      readonly kind: 'binding-started';
      readonly experimentId: string;
      readonly index: number;
      readonly total: number;
      readonly bindingId: string;
      readonly pluginId: string;
    }
  | {
      readonly kind: 'binding-detail';
      readonly experimentId: string;
      readonly bindingId: string;
      readonly pluginId: string;
      readonly detail: string;
    }
  | {
      readonly kind: 'binding-completed';
      readonly experimentId: string;
      readonly index: number;
      readonly total: number;
      readonly bindingId: string;
      readonly pluginId: string;
      readonly results: readonly BindingCleanupResult[];
      readonly handled: boolean;
    };

export type CleanupProgressReporter = (event: CleanupBindingProgress) => void;
export type CleanupProgressObserver = (
  event: CleanupBindingProgress,
) => void | Promise<void>;

/** Best-effort progress wrapper; never affects cleanup execution or outcomes. */
export function cleanupProgressReporter(
  observe: CleanupProgressObserver | undefined,
): CleanupProgressReporter | undefined {
  if (!observe) return undefined;
  return (event) => {
    try {
      const pending = observe(structuredClone(event));
      if (pending) void pending.catch(() => {});
    } catch {
      // Reporting is best effort.
    }
  };
}

export interface ExperimentCleanupReport {
  experimentId: string;
  dryRun: boolean;
  results: BindingCleanupResult[];
}

export class ExperimentInUseError extends Error {}

function cleanupFacts(
  store: FactStore,
  ownership: AbortSignal,
  dryRun: boolean,
): FactStore {
  return {
    read: store.read.bind(store),
    list: store.list.bind(store),
    scan: store.scan?.bind(store),
    write(kind, id, value) {
      ownership.throwIfAborted();
      if (dryRun) throw new Error('Cleanup previews cannot write facts');
      return store.write(kind, id, value);
    },
  };
}

const cleanupResultSchema: JsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['key', 'status'],
    properties: {
      key: { type: 'string', minLength: 1 },
      status: { enum: ['complete', 'preview', 'pending'] },
      report: { type: 'object' },
      error: { type: 'string' },
    },
  },
};

/** Read only this experiment's saved Recipes, including effective Policy defaults. */
async function readCleanupBindings({
  facts,
  experimentId,
  signal,
}: ExperimentCleanupContext): Promise<
  (CleanupBinding & { config?: JsonValue })[]
> {
  const bindings = new Map<string, CleanupBinding & { config?: JsonValue }>();
  function add(
    bindingId: string,
    plugin: unknown,
    config: JsonValue | undefined,
  ): void {
    const pluginId = string(plugin, 'cleanup plugin ID');
    const key = JSON.stringify([bindingId, pluginId]);
    // Definitions are traversed newest first.
    if (!bindings.has(key)) bindings.set(key, { bindingId, pluginId, config });
  }
  function addRecipe(recipe: JsonObject): void {
    const application = object(recipe.application);
    add('_application', application.plugin, application.config);
    for (const [name, entry] of Object.entries(object(recipe.bindings ?? {}))) {
      const binding = object(entry);
      add(name, binding.plugin, binding.config);
    }
  }

  let definition: JsonObject;
  try {
    definition = await facts.read('definitions', experimentId);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
    // A run that failed before locking its definition can still have a saved Recipe.
    const { recipe } = await facts.read('experiments', experimentId);
    if (recipe !== undefined) addRecipe(object(recipe));
    return [...bindings.values()];
  }
  for (;;) {
    signal.throwIfAborted();
    assertDefinitionDigest(definition);
    addRecipe(object(definition.recipe));
    if (definition.reflection) {
      const implementation = object(
        object(definition.reflection).implementation,
      );
      add('_reflection', implementation.ref, implementation.config);
    }
    if (definition.retry === undefined) break;
    const ref = string(
      object(definition.retry).previousDefinition,
      'previous definition',
    );
    definition = await facts.read('definition-attempts', ref);
    if (definitionArchiveId(experimentId, definition) !== ref)
      throw new Error(
        'Invalid archived definition for experiment ' + experimentId,
      );
  }
  return [...bindings.values()];
}

async function cleanupBinding(
  registry: Registry,
  runtime: RuntimeContext,
  context: CleanupContext,
  config: JsonValue | undefined,
  ownership: AbortSignal,
  reportProgress?: CleanupProgressReporter,
): Promise<CleanupResult[] | undefined> {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'arsi-cleanup-'),
  );
  const redact = reportProgress ? redactConfiguration(config) : undefined;
  const bindingContext = runtime.extend({
    experimentId: context.experimentId,
    bindingId: context.bindingId,
    callId: 'cleanup',
    directory: directory.path,
    dataDirectory: context.dataDirectory,
    facts: context.facts,
    signal: context.signal,
    cleanup: ownership,
    ...(reportProgress && redact
      ? {
          reportProgress(update) {
            const detail = update.detail ?? update.notice;
            if (!detail) return;
            reportProgress({
              kind: 'binding-detail',
              experimentId: context.experimentId,
              bindingId: context.bindingId,
              pluginId: context.pluginId,
              detail: redact(detail),
            });
          },
        }
      : {}),
  });
  return await withBindingInstance(
    registry,
    {
      plugin: context.pluginId,
      config: object(config === undefined ? {} : config),
    },
    bindingContext,
    'rsi/cleanup',
    (target, event) => target.serial(target, event, context),
  );
}

/**
 * Await one cleanup reply per distinct binding and plugin in the saved Recipes.
 * The caller holds the execution lock for writes. Its ownership signal lets handlers
 * record an interruption while the lock is still held.
 */
export async function dispatchRecipeCleanup(
  registry: Registry,
  runtime: RuntimeContext,
  request: ExperimentCleanupContext,
  ownership: AbortSignal = request.signal,
  onProgress?: CleanupProgressObserver,
): Promise<BindingCleanupResult[]> {
  const reportProgress = cleanupProgressReporter(onProgress);
  const context: ExperimentCleanupContext = {
    ...request,
    facts: cleanupFacts(request.facts, ownership, request.dryRun),
    signal: AbortSignal.any([request.signal, ownership]),
  };
  context.signal.throwIfAborted();
  const bindings = await readCleanupBindings(context);
  reportProgress?.({
    kind: 'bindings-discovered',
    experimentId: context.experimentId,
    totalBindings: bindings.length,
  });
  const results: BindingCleanupResult[] = [];
  for (const [index, { config, ...owner }] of bindings.entries()) {
    if (context.signal.aborted) break;
    reportProgress?.({
      kind: 'binding-started',
      experimentId: context.experimentId,
      index,
      total: bindings.length,
      bindingId: owner.bindingId,
      pluginId: owner.pluginId,
    });
    const bindingResults: BindingCleanupResult[] = [];
    let handled = true;
    try {
      const entries = await cleanupBinding(
        registry,
        runtime,
        { ...context, ...owner },
        config,
        ownership,
        reportProgress,
      );
      if (entries === undefined) {
        handled = false;
      } else {
        validate(cleanupResultSchema, entries, 'Plugin cleanup results');
        const expected = context.dryRun ? 'preview' : 'complete';
        if (
          entries.some(
            (entry) => entry.status !== expected && entry.status !== 'pending',
          )
        )
          throw new Error(
            'Plugin cleanup result does not match the requested mode',
          );
        for (const entry of entries) {
          if (entry.report !== undefined) json(entry.report);
          const record = { ...structuredClone(entry), ...owner };
          bindingResults.push(record);
          results.push(record);
        }
      }
    } catch (error) {
      const record: BindingCleanupResult = {
        ...owner,
        key: owner.bindingId,
        status: 'pending',
        error: redactConfiguration(config)(errorText(error)),
      };
      bindingResults.push(record);
      results.push(record);
    }
    reportProgress?.({
      kind: 'binding-completed',
      experimentId: context.experimentId,
      index,
      total: bindings.length,
      bindingId: owner.bindingId,
      pluginId: owner.pluginId,
      results: bindingResults,
      handled,
    });
  }
  return results;
}

/** Previews are read-only. Execution shares the lock used by run and resume. */
export async function collectExperimentCleanup(
  manager: Manager,
  report: ExperimentCleanupReport,
  signal: AbortSignal,
  onProgress?: CleanupProgressObserver,
): Promise<void> {
  const { experimentId, dryRun } = report;
  signal.throwIfAborted();
  const experiment = await manager.get(safeId(experimentId));
  if (experiment.id !== experimentId)
    throw new Error('Experiment identity mismatch');
  signal.throwIfAborted();
  const ownership = new AbortController();
  let release: (() => Promise<void>) | undefined;
  try {
    if (!dryRun) {
      const gate = await acquireResourceGate(manager.directory);
      try {
        release = await acquireExecutionLock(
          manager.directory,
          experimentId,
          gate,
          ownership,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ELOCKED'
        )
          throw new ExperimentInUseError(
            `Experiment ${experimentId} is in use. Preview with --dry-run or retry after it finishes.`,
          );
        throw error;
      } finally {
        await gate.release();
      }
    }
    report.results = await dispatchRecipeCleanup(
      manager.options.registry,
      manager.context,
      {
        experimentId,
        dryRun,
        dataDirectory: manager.directory,
        facts: manager.facts,
        signal,
      },
      ownership.signal,
      onProgress,
    );
    ownership.signal.throwIfAborted();
  } finally {
    await release?.();
  }
}
