import { agentProcessLauncher } from '../services/agent-execution/process.js';
import { errorText } from '../../shared/errors.js';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ArtifactStore,
  FactStore,
  WorkspaceService,
  Binding,
  JsonObject,
  JsonValue,
} from '../../contracts/index.js';
import { agentContract } from '../../contracts/plugin-types/agent.js';
import { RuntimeContext } from '../../contracts/runtime/context.js';
import { object, string, digest, freezeSnapshot } from '../../shared/json.js';
import {
  assertCallAdmitted,
  createCallExecutor,
  type CallExecutor,
} from './calls.js';
import { Instances } from './instances.js';
import { acquireExecutionLock } from './execution-lock.js';
import { ManagedEvents } from '../services/events.js';
import {
  finishedRunProgress,
  progressReporter,
  reusedCallsSummary,
  summarizeMeasurementDetails,
  type MeasurementSummary,
  type RunProgressObserver,
} from '../services/run-progress.js';
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
  assertDefinitionLock,
  definitionArchiveId,
  lockDefinition,
  parseLockedReflection,
  readResourceOrigins,
} from './definition-lock.js';
import { ExperimentFacts } from './facts.js';
import { readExperimentRecord } from './records.js';
import { assertRetryShape, readRetryCalls } from './retry.js';
import { BudgetLedger, ExperimentBudgetExceeded } from './budget.js';
import {
  CleanupLifecycle,
  archiveUnresolvedCleanup,
  assertCleanupResolved,
  reconcilePersistedCleanup,
} from './cleanup.js';
import { RevisionActivation } from './activation.js';
import { reflect } from '../revisions/index.js';
import { acquireResourceGate } from '../revisions/exclusion.js';
import { RevisionApplication } from '../revisions/application.js';
import {
  PolicyCheckpoints,
  readPolicyCheckpoint,
} from '../policy/checkpoint.js';
import {
  executeControlledPolicy,
  partialPolicyOutput,
  recoverPolicy,
  type PolicyRecovery,
} from '../policy/executor.js';

interface RunOptions {
  id?: string;
  signal?: AbortSignal;
  resume?: boolean;
  context?: RuntimeContext;
  /** Best-effort observations scoped to this run. */
  onProgress?: RunProgressObserver;
}

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
    if (cleanup && !cleanup.relinquished) {
      await cleanup.reconcile();
      this.cleanups.delete(id);
      return;
    }
    await reconcilePersistedCleanup(id, this.directory, this.facts);
    if (cleanup && this.cleanups.get(id) === cleanup) this.cleanups.delete(id);
  }
  run(recipePath: string, options: RunOptions = {}): Promise<JsonObject> {
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
    options: RunOptions = {},
  ): Promise<JsonObject> {
    const continuing = options.resume === true;
    const reportProgress = progressReporter(options.onProgress);
    const gate = await acquireResourceGate(this.directory);
    let recipe!: Recipe;
    let resourceOrigins: Record<string, Record<string, string>> = {};
    let id: string;
    const controller = new AbortController();
    const stopping = new AbortController();
    let failureCause: unknown;
    let releaseLock: () => Promise<void>;
    try {
      if (continuing) {
        if (!options.id) throw new Error('Resume requires an experiment id');
        id = safeId(options.id);
      } else {
        recipe = await Recipe.load(recipePath, this.options.registry);
        id = safeId(options.id ?? `${recipe.id}-${randomUUID().slice(0, 8)}`);
      }
      releaseLock = await acquireExecutionLock(
        this.directory,
        id,
        gate,
        controller,
      );
    } finally {
      await gate.release();
    }
    // Validate persisted identity under the lock before changing experiment facts.
    let resumedRecord: JsonObject | undefined;
    let definition: JsonObject | undefined;
    let recovery: PolicyRecovery | undefined;
    let retryCalls: ReadonlyMap<string, JsonObject> | undefined;
    let retryRef: string | undefined;
    let restore: JsonObject | undefined;
    const checkpoints = new PolicyCheckpoints(this.facts, id);
    const resources = join(this.directory, 'experiments', id, 'resources');
    try {
      if (continuing) {
        resumedRecord = readExperimentRecord(await this.get(id));
        if (resumedRecord.id !== id)
          throw new Error('Experiment identity mismatch');
        const locked = await this.facts.read('definitions', id);
        assertDefinitionLock(locked);
        if (resumedRecord.status === 'succeeded') {
          await assertCleanupResolved(this.facts, id);
          controller.signal.throwIfAborted();
          options.signal?.throwIfAborted();
          await releaseLock();
          reportProgress?.(
            finishedRunProgress(id, 'succeeded', resumedRecord, true),
          );
          return resumedRecord;
        }
        const readPolicy = (source = locked) =>
          new Policy(source.policy, {
            sourcePath: string(source.policySourcePath),
            contracts: this.options.registry,
          });
        const priorRetry = object(locked.retry ?? {});
        const oldPolicyInputs = (source: JsonObject) => {
          const policy = object(object(source.recipe).policy);
          return {
            config: object(policy.config),
            input: object(policy.input),
            application: {
              initialCandidate: object(resumedRecord!.application)
                .initialCandidateRef,
            },
          };
        };
        if (priorRetry.recovery !== undefined) {
          const saved = object(priorRetry.recovery);
          recovery = {
            identity: string(saved.identity),
            initialState: object(saved.initialState),
          };
        }
        recipe = await Recipe.load(recipePath, this.options.registry);
        assertRetryShape(locked, recipe.policy);
        retryCalls = await readRetryCalls(this.facts, id);
        restore = await checkpoints.restore();
        if (restore) {
          if (recovery) readPolicyCheckpoint(restore, recovery.identity);
          else
            recovery = recoverPolicy(
              readPolicy(),
              oldPolicyInputs(locked),
              restore,
            );
        }
        retryRef = 'retry-' + randomUUID();
        const archiveId = definitionArchiveId(id, locked);
        definition = await lockDefinition(
          recipe,
          this.options.registry,
          this.artifacts,
          resources,
          {
            ref: retryRef,
            previousDefinition: archiveId,
            ...(recovery ? { recovery: { ...recovery } } : {}),
          },
          locked,
        );
        recipe = await Recipe.fromJSON(
          definition.recipe,
          this.options.registry,
          {
            sourcePath: recipe.sourcePath,
            policy: recipe.policy,
            ...(definition.reflection
              ? { reflection: parseLockedReflection(definition.reflection) }
              : {}),
          },
        );
        await archiveUnresolvedCleanup(this.facts, id, archiveId);
        await this.facts.write('definition-attempts', archiveId, locked);
        await this.facts.write('definitions', id, definition);
        resourceOrigins = readResourceOrigins(definition);
      } else {
        await assertCleanupResolved(this.facts, id);
        try {
          await this.get(id);
          throw new Error('Experiment already exists; use --resume');
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
    let wallDeadline =
      elapsedWallMs === undefined || continuing
        ? undefined
        : AbortSignal.timeout(elapsedWallMs);
    let signal = AbortSignal.any([
      controller.signal,
      stopping.signal,
      ...(wallDeadline ? [wallDeadline] : []),
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
      if (continuing) {
        const previous = resumedRecord!;
        initial = object(previous.application);
        experimentStartedAt =
          typeof previous.startedAt === 'string'
            ? previous.startedAt
            : experimentStartedAt;
        try {
          budget.restore(await this.facts.read('budgets', id));
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              'code' in error &&
              error.code === 'ENOENT'
            ) ||
            Object.keys(object(previous.usage ?? {})).length !== 0
          )
            throw error;
        }
        if (elapsedWallMs !== undefined) {
          const elapsed = Date.now() - Date.parse(experimentStartedAt);
          if (!Number.isFinite(elapsed))
            throw new Error('Invalid persisted experiment start time');
          const remaining = elapsedWallMs - Math.max(0, elapsed);
          if (remaining <= 0)
            throw new ExperimentBudgetExceeded('elapsedWallMs');
          wallDeadline = AbortSignal.timeout(remaining);
          signal = AbortSignal.any([signal, wallDeadline]);
        }
        await this.facts.write('controls', id, {
          cancel: false,
          clearedAt: new Date().toISOString(),
        });
      }
      if (!continuing) {
        const locked = await lockDefinition(
          recipe,
          this.options.registry,
          this.artifacts,
          resources,
        );
        definition = locked;
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
        reportProgress,
        bindingVersions: definition && object(definition.bindingVersions),
      });
      const measurementSummaries = new Map<
        string,
        Map<string, MeasurementSummary>
      >();
      const experimentFacts = new ExperimentFacts(
        id,
        this.facts,
        this.artifacts,
        this.options.registry,
        (bindingId) => activation.bindings[bindingId]?.plugin,
      );
      const calls = createCallExecutor({
        id,
        registry: this.options.registry,
        facts: this.facts,
        revisionRefs: activation.revisionRefs,
        retryCalls,
        retryRef,
        context,
        binding: (name) =>
          name === '_application'
            ? recipe.application.toJSON()
            : activation.bindings[name],
        operation: (bindingId, binding) =>
          instances.acquire(bindingId, binding),
        charge,
        diagnose,
        reportProgress,
        consumeMeasurementSummary: (callId, ref) => {
          const summaries = measurementSummaries.get(callId);
          measurementSummaries.delete(callId);
          return ref === undefined ? undefined : summaries?.get(ref);
        },
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
        runAgentProcess(this: RuntimeContext, spec, onLine) {
          if (
            recipe.budget.modelCalls !== undefined ||
            this.scope?.limits.modelCalls !== undefined
          )
            throw new Error(
              'Native CLI execution cannot enforce the configured modelCalls budget',
            );
          return agentProcessLauncher({
            project: this.agentProject ?? this.directory,
            signal: this.signal,
          })(spec, onLine);
        },
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
          const ref = await experimentFacts.recordMeasurement(
            measurement,
            ctx,
            reportProgress
              ? (saved) => {
                  const summary = summarizeMeasurementDetails(saved);
                  if (!summary || typeof saved.ref !== 'string') return;
                  const summaries =
                    measurementSummaries.get(ctx.callId) ??
                    new Map<string, MeasurementSummary>();
                  summaries.set(saved.ref, summary);
                  measurementSummaries.set(ctx.callId, summaries);
                }
              : undefined,
          );
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
        async invokeAgent(this: RuntimeContext, agentRef, input) {
          const binding = activation.bindings[agentRef];
          if (!binding) throw new Error(`Unknown Agent ${agentRef}`);
          if (
            manager.options.registry.get(binding.plugin).contract.id !==
            agentContract.id
          )
            throw new Error(
              `Binding ${agentRef} does not implement contract.agent`,
            );
          const event = freezeSnapshot({
            experimentId: id,
            callerBindingId: this.bindingId,
            callerDirectory: this.directory,
            agentRef,
            input: structuredClone(input),
          });
          const decision = await this.event.waterfall(
            'rsi/before-agent-invoke',
            event,
            async () => ({
              kind: 'proceed',
              input: structuredClone(event.input),
            }),
          );
          this.signal.throwIfAborted();
          assertCallAdmitted(decision);
          return object(
            await calls.invoke(
              agentRef,
              decision.input,
              this,
              undefined,
              decision.metadata,
            ),
          );
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
            digest({
              callId: ctx.idempotencyKey,
              candidateRef,
              capability,
            }).slice(0, 32);
          let error: unknown;
          try {
            ctx.reportProgress?.({
              detail: `acquiring ${capability} instance`,
            });
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
            ctx.reportProgress?.({
              detail: `releasing ${capability} instance`,
            });
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
              throw error === undefined
                ? cleanupError
                : Object.assign(
                    new AggregateError(
                      [error, cleanupError],
                      'Instance cleanup was not confirmed',
                    ),
                    { status: 'unknown' },
                  );
            }
          }
        },
      });
      const priorReflections = new Map<string, JsonObject[]>();
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
            attempt: retryRef,
          },
          priorAttempts: priorReflections.get(stepPath),
          generatorCommitted: (reflectionId) =>
            retryCalls?.get(`reflection/${reflectionId}`)?.status ===
            'succeeded',
          generatorBinding: '_reflection',
          sourceResources: resourceOrigins,
          state,
          bindings: activation.bindings,
          context: caller,
          directory: this.directory,
          revisionRefs: activation.revisionRefs,
          getDefinition: (pluginId) => this.options.registry.get(pluginId),
          invoke: async (binding, value, key, scope) => {
            const prior = retryCalls?.get(key);
            const path =
              prior?.status === 'succeeded' &&
              digest(prior.input) !== digest(value)
                ? `${key}/${retryRef}`
                : key;
            return calls.invoke(
              binding,
              value,
              caller.extend({
                scope,
                signal: AbortSignal.any([caller.signal, scope.signal]),
              }),
              path,
            );
          },
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
      if (continuing) {
        const reflectionFacts = this.facts.scan
          ? this.facts.scan('reflection')
          : await this.facts.list('reflection');
        for await (const fact of reflectionFacts) {
          if (fact.experimentId !== id) continue;
          if (
            fact.policyScopeId === 'root' &&
            typeof fact.stepPath === 'string'
          ) {
            const attempts = priorReflections.get(fact.stepPath) ?? [];
            attempts.push(fact);
            priorReflections.set(fact.stepPath, attempts);
          }
        }
      }
      if (continuing) await activation.restore();
      const experimentInfo = {
        experimentId: id,
        recipeId: recipe.id,
        policyId: policy.id,
        resumed: continuing,
      };
      reportProgress?.({ kind: 'experiment-preparing', ...experimentInfo });
      if (continuing) {
        const reusedCalls = reusedCallsSummary(retryCalls);
        const priorUsage = Object.fromEntries(
          Object.entries(budget.usage).filter(
            (entry): entry is [string, number] => typeof entry[1] === 'number',
          ),
        );
        if (reusedCalls.length > 0 || Object.keys(priorUsage).length > 0) {
          reportProgress?.({
            kind: 'experiment-resumed',
            experimentId: id,
            reusedCalls,
            priorUsage,
          });
        }
      }
      await businessWait(
        services.event.serial('rsi/before-experiment', experimentInfo),
      );
      signal.throwIfAborted();
      if (!continuing || typeof initial.initialCandidateRef !== 'string')
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
        recipePath: recipe.sourcePath,
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
          recovery,
          routing: {
            committedOutput(path) {
              const call = retryCalls?.get(path);
              return call?.status === 'succeeded' ? call.output : undefined;
            },
          },
          events: {
            info: {
              experimentId: id,
              policyScopeId: 'root',
              checkpointRef: id,
            },
            diagnose,
            reportProgress,
          },
          invoke: async (binding, value, path) =>
            calls.invoke(binding, value, root, path),
          incrementalCheckpoint: checkpoints,
          reflect: (path, state, parallel) =>
            runReflection(root, path, state, parallel),
        }),
      );
      reportProgress?.({ kind: 'experiment-cleaning' });
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
      reportProgress?.(finishedRunProgress(id, terminal, complete));
      return complete;
    } catch (error) {
      const wasCancelled = signal.aborted;
      const cause: unknown = wasCancelled ? signal.reason : error;
      const budgetMetric =
        cause instanceof ExperimentBudgetExceeded
          ? cause.metric
          : wallDeadline?.aborted && cause === wallDeadline.reason
            ? 'elapsedWallMs'
            : undefined;
      stopping.abort(error);
      try {
        reportProgress?.({ kind: 'experiment-cleaning' });
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
        recipePath: recipe.sourcePath,
        startedAt: experimentStartedAt,
        recipe: recipe.toJSON(),
        application: initial,
      };
      try {
        previous = await this.get(id);
      } catch {}
      const status =
        failureCause !== undefined || budgetMetric !== undefined
          ? 'failed'
          : wasCancelled
            ? 'cancelled'
            : 'failed';
      let partialOutput: JsonValue | undefined;
      if (budgetMetric !== undefined) {
        try {
          const snapshot = await new PolicyCheckpoints(
            this.facts,
            id,
          ).restoreOrdered();
          if (snapshot)
            partialOutput = partialPolicyOutput(
              recipe.policy,
              {
                input: recipe.policyInput,
                config: recipe.policyConfig,
                application: { initialCandidate: initial.initialCandidateRef },
              },
              snapshot,
              recovery,
            );
        } catch (projectionError) {
          diagnose('rsi/partial-policy-output', projectionError);
        }
      }
      await cleanup.markPending();
      terminalSaveAttempted = true;
      const stopped: JsonObject = {
        ...previous,
        ...(retryRef
          ? {
              recipeId: recipe.id,
              recipePath: recipe.sourcePath,
              recipe: recipe.toJSON(),
              application: initial,
            }
          : {}),
        status,
        error: errorText(error),
        ...(budgetMetric === undefined
          ? {}
          : { stopReason: 'budget-exhausted', budgetMetric }),
        ...(partialOutput === undefined ? {} : { partialOutput }),
        usage: budget.usage,
        finishedAt: new Date().toISOString(),
      };
      await this.facts.write('experiments', id, stopped);
      terminal = status;
      reportProgress?.(finishedRunProgress(id, status, stopped));
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
      const cleanupJob = cleanup.start(
        drain,
        finalNotification,
        () => Promise.allSettled([...diagnostics]),
        terminal !== 'succeeded',
      );
      void cleanupJob.then(
        () => {
          if (this.cleanups.get(id) === cleanup) this.cleanups.delete(id);
        },
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
