import { errorText } from '../../shared/errors.js';
import { mkdir } from 'node:fs/promises';
import { lock as acquireProcessLock } from 'proper-lockfile';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ArtifactStore,
  FactStore,
  WorkspaceService,
  Binding,
  JsonObject,
  JsonValue,
} from '../../contracts/index.js';
import { RuntimeContext } from '../../contracts/runtime/context.js';
import { object, string, digest } from '../../shared/json.js';
import { createCallExecutor, type CallExecutor } from './calls.js';
import { Instances } from './instances.js';
import { ManagedEvents } from '../services/events.js';
import {
  FileArtifacts,
  FileFacts,
  FileWorkspaces,
  safeId,
} from '../storage/index.js';
import { Registry } from '../registry/index.js';
import { Recipe } from '../loaders/recipe.js';
import { Policy } from '../policy/index.js';
import {
  lockDefinition,
  restoreDefinition,
  parseLockedReflection,
  readResourceOrigins,
} from './definition-lock.js';
import { ExperimentFacts } from './facts.js';
import { readExperimentRecord } from './records.js';
import { BudgetLedger } from './budget.js';
import {
  CleanupLifecycle,
  assertCleanupResolved,
  reconcilePersistedCleanup,
} from './cleanup.js';
import { RevisionActivation } from './activation.js';
import { reflect } from '../revisions/index.js';
import { acquireResourceGate } from '../revisions/exclusion.js';
import { RevisionApplication } from '../revisions/application.js';
import { PolicyCheckpoints } from '../policy/checkpoint.js';
import { executeControlledPolicy } from '../policy/executor.js';

export interface RuntimeOptions {
  context?: RuntimeContext;
  rootDirectory?: string;
  directory?: string;
  registry: Registry;
  artifacts?: ArtifactStore;
  facts?: FactStore;
  workspaces?: WorkspaceService;
}
export class Manager {
  readonly context: RuntimeContext;
  readonly rootDirectory: string;
  readonly directory: string;
  readonly artifacts: ArtifactStore;
  readonly facts: FactStore;
  readonly workspaces: WorkspaceService;
  private readonly running = new Map<string, AbortController>();
  private readonly jobs = new Set<Promise<JsonObject>>();
  private readonly cleanups = new Map<string, CleanupLifecycle>();
  async dispose(): Promise<void> {
    for (const controller of this.running.values())
      controller.abort(new Error('Runtime disposed'));
    await Promise.allSettled([...this.jobs]);
    const results = await Promise.allSettled(
      [...this.cleanups.values()].map(async (cleanup) => {
        await cleanup.observe();
        if (cleanup.released) this.cleanups.delete(cleanup.id);
      }),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Runtime cleanup failed',
      );
  }

  /** Confirm failed external cleanup was reconciled; never retries plugin disposal. */
  async reconcileCleanup(id: string): Promise<void> {
    safeId(id);
    const cleanup = this.cleanups.get(id);
    if (cleanup) {
      await cleanup.reconcile();
      this.cleanups.delete(id);
      return;
    }
    await reconcilePersistedCleanup(id, this.directory, this.facts);
  }
  run(
    recipePath: string,
    options: {
      id?: string;
      signal?: AbortSignal;
      resume?: boolean;
      context?: RuntimeContext;
    } = {},
  ): Promise<JsonObject> {
    const job = this.execute(recipePath, options);
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => {});
    return job;
  }
  constructor(readonly options: RuntimeOptions) {
    this.rootDirectory = resolve(options.rootDirectory ?? process.cwd());
    this.directory = resolve(
      options.directory ?? join(this.rootDirectory, '.rsi'),
    );
    this.artifacts =
      options.artifacts ?? new FileArtifacts(join(this.directory, 'artifacts'));
    this.facts = options.facts ?? new FileFacts(join(this.directory, 'facts'));
    this.workspaces =
      options.workspaces ??
      new FileWorkspaces(join(this.directory, 'workspaces'), this.artifacts);
    this.context = (options.context ?? new RuntimeContext()).extend({
      rootDirectory: this.rootDirectory,
      dataDirectory: this.directory,
      artifacts: this.artifacts,
      facts: this.facts,
      workspaces: this.workspaces,
    });
  }
  async cancel(id: string): Promise<void> {
    safeId(id);
    const record = await this.get(id);
    if (record.status !== 'running')
      throw new Error('Experiment is not running');
    await this.facts.write('controls', id, {
      cancel: true,
      requestedAt: new Date().toISOString(),
    });
    this.running.get(id)?.abort(new Error('Experiment cancelled'));
  }
  async list(): Promise<JsonObject[]> {
    return this.facts.list('experiments');
  }
  async get(id: string): Promise<JsonObject> {
    return this.facts.read('experiments', id);
  }
  /** Saved revisions remain inspectable independently of an experiment's lifetime. */
  reflection(): RevisionApplication {
    return new RevisionApplication({
      directory: this.directory,
      rootDirectory: this.rootDirectory,
      facts: this.facts,
      artifacts: this.artifacts,
    });
  }
  private async execute(
    recipePath: string,
    options: {
      id?: string;
      signal?: AbortSignal;
      resume?: boolean;
      context?: RuntimeContext;
    } = {},
  ): Promise<JsonObject> {
    const gate = await acquireResourceGate(this.directory);
    let recipe!: Recipe;
    let resourceOrigins: Record<string, Record<string, string>> = {};
    let id: string;
    const controller = new AbortController();
    const stopping = new AbortController();
    let failureCause: unknown;
    let releaseLock: () => Promise<void>;
    try {
      if (options.resume) {
        if (!options.id) throw new Error('Resume requires an experiment id');
        id = safeId(options.id);
      } else {
        recipe = await Recipe.load(recipePath, this.options.registry);
        id = safeId(options.id ?? `${recipe.id}-${randomUUID().slice(0, 8)}`);
      }
      const lock = join(this.directory, 'locks', id);
      await mkdir(dirname(lock), { recursive: true });
      gate.assertOwned();
      releaseLock = await acquireProcessLock(lock, {
        realpath: false,
        stale: 60000,
        update: 10000,
        retries: 0,
        onCompromised: (error) => controller.abort(error),
      });
    } finally {
      await gate.release();
    }
    // Validate persisted identity under the lock before changing experiment facts.
    let resumedRecord: JsonObject | undefined;
    try {
      await assertCleanupResolved(this.facts, id);
      if (options.resume) {
        resumedRecord = readExperimentRecord(await this.get(id));
        if (resumedRecord.recipePath !== resolve(recipePath))
          throw new Error(
            'Experiment recipePath differs from the saved Recipe',
          );
        const locked = await this.facts.read('definitions', id);
        if (locked.schemaVersion !== 'rsi.definition-lock/v1')
          throw new Error('Unsupported experiment definition lock');
        await restoreDefinition(
          locked,
          this.artifacts,
          join(this.directory, 'experiments', id, 'resources'),
        );
        resourceOrigins = readResourceOrigins(locked);
        const lockedPolicy = new Policy(locked.policy, {
          sourcePath: string(locked.policySourcePath),
          contracts: this.options.registry,
        });
        const rawReflection = locked.reflection;
        recipe = await Recipe.fromJSON(locked.recipe, this.options.registry, {
          sourcePath: string(locked.recipeSourcePath),
          policy: lockedPolicy,
          ...(rawReflection
            ? { reflection: parseLockedReflection(rawReflection) }
            : {}),
        });
      } else {
        try {
          await this.get(id);
          throw new Error('Experiment already exists; use resume');
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
      }
    } catch (error) {
      await releaseLock();
      throw error;
    }
    if (resumedRecord?.status === 'succeeded') {
      await releaseLock();
      return resumedRecord;
    }
    this.running.set(id, controller);
    const cancellationPoll = setInterval(() => {
      void this.facts
        .read('controls', id)
        .then((v) => {
          if (v.cancel === true)
            controller.abort(new Error('Experiment cancelled'));
        })
        .catch(() => {});
    }, 500);
    cancellationPoll.unref();
    const started = Date.now();
    let experimentStartedAt = new Date(started).toISOString();
    const elapsedWallMs = recipe.budget.elapsedWallMs;
    let signal = AbortSignal.any([
      controller.signal,
      stopping.signal,
      ...(elapsedWallMs === undefined || options.resume
        ? []
        : [AbortSignal.timeout(elapsedWallMs)]),
      ...(options.signal ? [options.signal] : []),
    ]);
    const registrations = new Map<string, () => void>();
    const budget = new BudgetLedger(id, this.facts, recipe.budget, (error) => {
      failureCause = error;
      stopping.abort(error);
    });
    let initial: JsonObject = {};
    // Definition locking can fail before the call executor is assembled.
    let activeCalls: CallExecutor | undefined;
    let services: RuntimeContext;
    const cleanupMs = recipe.budget.cleanupReserveMs;
    let acceptingBusiness = true;
    let terminalSaveAttempted = false;
    let terminal: 'succeeded' | 'failed' | 'cancelled' | undefined;
    const assertBusiness = (): void => {
      if (!acceptingBusiness)
        throw new Error('Experiment no longer accepts business calls');
    };
    const context = (
      bindingId: string,
      callId: string,
      parent = services,
    ): RuntimeContext =>
      parent.extend({
        callId,
        bindingId,
        idempotencyKey: callId,
        directory: join(this.directory, 'experiments', id, 'calls', callId),
      });
    const diagnostics = new Set<Promise<void>>();
    const businessTasks = new Set<Promise<unknown>>();
    const businessWait = async <T>(job: Promise<T>): Promise<T> => {
      businessTasks.add(job);
      void job.finally(() => businessTasks.delete(job)).catch(() => {});
      let abort: (() => void) | undefined;
      try {
        return await Promise.race([
          job,
          new Promise<never>((_resolve, reject) => {
            abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          }),
        ]);
      } finally {
        if (abort) signal.removeEventListener('abort', abort);
      }
    };
    const diagnose = (
      eventName: string,
      error: unknown,
      details: JsonObject = {},
    ): void => {
      const job = this.facts.write(
        'event-diagnostics',
        `${id}-${randomUUID()}`,
        {
          experimentId: id,
          eventName,
          ...details,
          error: errorText(error),
        },
      );
      diagnostics.add(job);
      void job.finally(() => diagnostics.delete(job)).catch(() => {});
    };
    const events = new ManagedEvents({
      context: (bindingId, listenerId, instanceSignal) =>
        context(bindingId, listenerId).extend({
          signal: AbortSignal.any([signal, instanceSignal]),
        }),
      diagnostic: ({ eventName, bindingId, listenerId, error }) =>
        diagnose(eventName, error, {
          bindingId: bindingId ?? null,
          listenerId: listenerId ?? null,
        }),
    });
    const instances = new Instances(
      this.options.registry,
      events,
      (bindingId) => context(bindingId, 'instance-' + randomUUID()),
    );
    const cleanup = new CleanupLifecycle(
      id,
      cleanupMs,
      this.facts,
      events,
      instances,
      async () => {
        for (const release of registrations.values()) release();
        registrations.clear();
        await releaseLock();
      },
    );
    this.cleanups.set(id, cleanup);
    const charge = async (
      metric: string,
      amount: number,
      ctx: RuntimeContext,
    ): Promise<void> => {
      assertBusiness();
      await budget.charge(metric, amount, ctx);
    };
    const drain = async (closeWhenIdle = false): Promise<void> => {
      do {
        await Promise.all([
          events.idle(),
          activeCalls?.idle(),
          Promise.allSettled([...businessTasks]),
        ]);
      } while (events.pending || activeCalls?.pending || businessTasks.size);
      if (closeWhenIdle) closeBusiness();
    };
    const closeBusiness = (): void => {
      acceptingBusiness = false;
      activeCalls?.close();
    };
    try {
      if (!options.resume) {
        const locked = await lockDefinition(
          recipe,
          this.options.registry,
          this.artifacts,
          join(this.directory, 'experiments', id, 'resources'),
        );
        await this.facts.write('definitions', id, locked);
        resourceOrigins = readResourceOrigins(locked);
        recipe = await Recipe.fromJSON(locked.recipe, this.options.registry, {
          sourcePath: string(locked.recipeSourcePath),
          policy: recipe.policy,
          ...(locked.reflection
            ? { reflection: parseLockedReflection(locked.reflection) }
            : {}),
        });
      }
      const policy = recipe.policy;
      const bindings: Record<string, Binding> = Object.fromEntries(
        Object.entries(recipe.bindings).map(([name, binding]) => [
          name,
          binding.toJSON(),
        ]),
      );
      const reflection = recipe.reflection
        ? structuredClone(recipe.reflection)
        : undefined;
      if (reflection) {
        const generatorBinding = '_reflection';
        bindings[generatorBinding] = {
          plugin: reflection.implementation.ref,
          config: reflection.implementation.config,
        };
      }
      const activation = new RevisionActivation({
        id,
        bindings,
        facts: this.facts,
        registry: this.options.registry,
        instances,
        cleanup,
        event: events.event,
        diagnose,
      });
      const experimentFacts = new ExperimentFacts(
        id,
        this.facts,
        this.artifacts,
        this.options.registry,
        (bindingId) => activation.bindings[bindingId]?.plugin,
      );
      const checkpoints = new PolicyCheckpoints(this.facts, id);
      const calls = createCallExecutor({
        id,
        registry: this.options.registry,
        facts: this.facts,
        revisionRefs: activation.revisionRefs,
        context,
        binding: (name) =>
          name === '_application'
            ? recipe.application.toJSON()
            : activation.bindings[name],
        operation: (bindingId, binding) =>
          instances.acquire(bindingId, binding),
        charge,
        diagnose,
        onFailure: (error, caller) => {
          if (!caller.scope && !signal.aborted) {
            failureCause = error;
            stopping.abort(error);
          }
        },
      });
      activeCalls = calls;
      const manager = this;
      services = (options.context ?? this.context).extend({
        experimentId: id,
        event: events.event,
        get signal() {
          return signal;
        },
        get cleanup() {
          return cleanup.signal;
        },
        rootDirectory: manager.rootDirectory,
        dataDirectory: manager.directory,
        artifacts: manager.artifacts,
        facts: manager.facts,
        workspaces: manager.workspaces,
        async charge(this: RuntimeContext, metric, amount) {
          return charge(metric, amount, this);
        },
        async readCandidate(this: RuntimeContext, ref) {
          return experimentFacts.readCandidate(ref, this);
        },
        async readMeasurement(this: RuntimeContext, ref) {
          return experimentFacts.readMeasurement(ref, this);
        },
        async recordCandidate(this: RuntimeContext, artifactRef, parentRef) {
          const ctx = this;
          assertBusiness();
          const ref = await experimentFacts.recordCandidate(
            artifactRef,
            parentRef,
            ctx,
          );
          try {
            services.event.emit('rsi/candidate-recorded', {
              experimentId: id,
              callId: ctx.callId,
              bindingId: ctx.bindingId,
              candidateRef: ref,
              parentRef,
            });
          } catch (error) {
            diagnose('rsi/candidate-recorded', error);
          }
          return ref;
        },
        async recordMeasurement(this: RuntimeContext, measurement) {
          const ctx = this;
          assertBusiness();
          const ref = await experimentFacts.recordMeasurement(measurement, ctx);
          try {
            services.event.emit('rsi/measurement-recorded', {
              experimentId: id,
              callId: ctx.callId,
              bindingId: ctx.bindingId,
              measurementRef: ref,
            });
          } catch (error) {
            diagnose('rsi/measurement-recorded', error);
          }
          return ref;
        },
        async applicationMetadata(this: RuntimeContext) {
          const ctx = this;
          if (ctx.experimentId !== id)
            throw new Error(
              'Application metadata belongs to another experiment',
            );
          return {
            target: initial.target ?? null,
            capabilities: initial.capabilities ?? [],
            initialCandidateRef: initial.initialCandidateRef ?? null,
          };
        },
        async application(this: RuntimeContext, input) {
          return object(await calls.invoke('_application', input, this));
        },
        async invoke(this: RuntimeContext, binding, input) {
          return calls.invoke(binding, input, this);
        },
        async invokeAgent(this: RuntimeContext, input) {
          const ctx = this;
          const ref = string(input.agentRef ?? 'agent.default');
          if (!activation.bindings[ref])
            throw new Error(`Unknown Agent ${ref}`);
          return object(await calls.invoke(ref, input, ctx));
        },
        async readEvidence(this: RuntimeContext, refs, options) {
          return experimentFacts.readEvidence(refs, options, this);
        },
        async withInstance(
          this: RuntimeContext,
          candidateRef,
          capability,
          use,
        ) {
          const ctx = this;
          const instanceId =
            'instance-' +
            digest({ callId: ctx.callId, candidateRef, capability }).slice(
              0,
              32,
            );
          let error: unknown;
          try {
            const acquire = object(
              await calls.invoke(
                '_application',
                { action: 'acquire', candidateRef, capability, instanceId },
                ctx,
                'acquire',
              ),
            );
            return await use(object(acquire.execution));
          } catch (caught) {
            error = caught;
            throw caught;
          } finally {
            const cleanupContext = ctx.extend({ signal: ctx.cleanup });
            try {
              await calls.invoke(
                '_application',
                { action: 'release', instanceId },
                cleanupContext,
                'release',
              );
            } catch (cleanupError) {
              await cleanup.externalFailure(cleanupError, instanceId);
              if (error === undefined) throw cleanupError;
            }
          }
        },
      });
      const runReflection = async (
        caller: RuntimeContext,
        stepPath: string,
        state: JsonObject,
        parallel: boolean,
      ): Promise<JsonValue> => {
        if (parallel)
          throw new Error(`${stepPath}: Reflection requires serial execution`);
        if (!reflection)
          throw new Error(
            `${stepPath}: Reflection module is not declared by this Policy`,
          );
        return reflect({
          config: reflection,
          invocation: {
            policyScopeId: 'root',
            stepPath,
          },
          generatorBinding: '_reflection',
          sourceResources: resourceOrigins,
          state,
          bindings: activation.bindings,
          context: caller,
          directory: this.directory,
          revisionRefs: activation.revisionRefs,
          getDefinition: (pluginId) => this.options.registry.get(pluginId),
          invoke: async (binding, value, key, scope) =>
            calls.invoke(
              binding,
              value,
              caller.extend({
                scope,
                signal: AbortSignal.any([caller.signal, scope.signal]),
              }),
              key,
            ),
          initialize: (parents) => activation.initialize(parents),
          save: (changes, revisions, activationId) =>
            activation.save(changes, revisions, activationId),
        });
      };
      for (const b of [
        recipe.application.toJSON(),
        ...Object.values(bindings),
      ]) {
        if (!registrations.has(b.plugin))
          registrations.set(b.plugin, this.options.registry.retain(b.plugin));
      }
      const reflectionConfiguration: JsonObject = reflection
        ? { '': { path: reflection.path, digest: reflection.digest } }
        : {};
      let lockedReflection: JsonObject | undefined;
      try {
        lockedReflection = await this.facts.read('reflection-configs', id);
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
      if (options.resume && (lockedReflection || reflection)) {
        if (
          !lockedReflection ||
          lockedReflection.interface !== 'explicit-reflection/v1' ||
          digest(lockedReflection.configuration) !==
            digest(reflectionConfiguration)
        )
          throw new Error(
            'Reflection configuration source or contents differ from the locked experiment',
          );
      } else if (reflection) {
        await this.facts.write('reflection-configs', id, {
          interface: 'explicit-reflection/v1',
          configuration: reflectionConfiguration,
        });
      }
      let restore: JsonObject | undefined;
      if (options.resume) {
        const reflectionFacts = this.facts.scan
          ? this.facts.scan('reflection')
          : await this.facts.list('reflection');
        for await (const fact of reflectionFacts)
          if (
            fact.experimentId === id &&
            fact.interface !== 'explicit-reflection/v1'
          )
            throw new Error(
              'Legacy Reflection boundary records cannot resume through the explicit Reflection interface; use the original implementation and configuration',
            );
        const previous = resumedRecord!;
        experimentStartedAt =
          typeof previous.startedAt === 'string'
            ? previous.startedAt
            : experimentStartedAt;
        if (elapsedWallMs !== undefined) {
          const elapsed = Date.now() - Date.parse(experimentStartedAt);
          if (!Number.isFinite(elapsed))
            throw new Error('Invalid persisted experiment start time');
          const remaining = elapsedWallMs - Math.max(0, elapsed);
          if (remaining <= 0)
            throw new Error('Experiment wall-time budget exceeded');
          signal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
        }
        initial = object(previous.application);
        restore = await checkpoints.restore();
        await this.facts.write('controls', id, {
          cancel: false,
          clearedAt: new Date().toISOString(),
        });
        budget.restore(await this.facts.read('budgets', id));
      }
      if (options.resume) await activation.restore();
      const experimentInfo = {
        experimentId: id,
        recipeId: recipe.id,
        policyId: policy.id,
        resumed: options.resume === true,
      };
      await businessWait(
        services.event.serial('rsi/before-experiment', experimentInfo),
      );
      signal.throwIfAborted();
      if (!options.resume || typeof initial.initialCandidateRef !== 'string')
        initial = object(
          await businessWait(
            calls.invoke(
              '_application',
              { action: 'initialize' },
              context('_root', 'root'),
              'initialize',
            ),
          ),
        );
      await this.facts.write('experiments', id, {
        id,
        recipeId: recipe.id,
        recipePath: resolve(recipePath),
        status: 'running',
        application: initial,
        startedAt: experimentStartedAt,
        recipe: recipe.toJSON(),
      });
      try {
        services.event.emit('rsi/experiment-started', experimentInfo);
      } catch (error) {
        diagnose('rsi/experiment-started', error);
      }
      const root = context('_root', 'root');
      const result = await businessWait(
        executeControlledPolicy(policy, {
          input: recipe.policyInput,
          config: recipe.policyConfig,
          application: { initialCandidate: initial.initialCandidateRef },
          context: root,
          restore,
          events: {
            info: {
              experimentId: id,
              policyScopeId: 'root',
              checkpointRef: id,
            },
            diagnose,
          },
          invoke: async (binding, value, path) =>
            calls.invoke(binding, value, root, path),
          incrementalCheckpoint: checkpoints,
          reflect: (path, state, parallel) =>
            runReflection(root, path, state, parallel),
        }),
      );
      await cleanup.within(drain(true));
      signal.throwIfAborted();
      if (failureCause !== undefined) throw failureCause;
      closeBusiness();
      const complete: JsonObject = {
        ...(await this.get(id)),
        status: 'succeeded',
        output: result,
        usage: budget.usage,
        durationMs: Date.now() - Date.parse(experimentStartedAt),
        finishedAt: new Date().toISOString(),
      };
      await cleanup.markPending();
      terminalSaveAttempted = true;
      await this.facts.write('experiments', id, complete);
      terminal = 'succeeded';
      return complete;
    } catch (error) {
      const wasCancelled = signal.aborted;
      stopping.abort(error);
      try {
        await cleanup.within(drain(true));
      } catch (cleanupError) {
        closeBusiness();
        events.abort(undefined, cleanupError);
        await activeCalls?.unconfirmed();
        await cleanup.record(cleanupError);
      }
      closeBusiness();
      if (terminalSaveAttempted) throw error;
      let previous: JsonObject = {
        id,
        recipeId: recipe.id,
        recipePath: resolve(recipePath),
        startedAt: experimentStartedAt,
        recipe: recipe.toJSON(),
        application: initial,
      };
      try {
        previous = await this.get(id);
      } catch {}
      const status =
        failureCause !== undefined
          ? 'failed'
          : wasCancelled
            ? 'cancelled'
            : 'failed';
      await cleanup.markPending();
      terminalSaveAttempted = true;
      await this.facts.write('experiments', id, {
        ...previous,
        status,
        error: errorText(error),
        usage: budget.usage,
        finishedAt: new Date().toISOString(),
      });
      terminal = status;
      throw error;
    } finally {
      closeBusiness();
      let finalNotification: Promise<unknown> = Promise.resolve();
      if (terminal) {
        try {
          finalNotification = events.event
            .parallel('rsi/experiment-finished', {
              experimentId: id,
              recipeId: recipe.id,
              status: terminal,
            })
            .catch((error: unknown) =>
              diagnose('rsi/experiment-finished', error),
            );
        } catch (error) {
          diagnose('rsi/experiment-finished', error);
        }
      }
      events.stop();
      clearInterval(cancellationPoll);
      this.running.delete(id);
      const cleanupJob = cleanup.start(drain, finalNotification, () =>
        Promise.allSettled([...diagnostics]),
      );
      void cleanupJob.then(
        () => this.cleanups.delete(id),
        () => {},
      );
      try {
        await cleanup.within(cleanupJob);
      } catch (error) {
        events.abort(undefined, error);
      }
    }
  }
}
