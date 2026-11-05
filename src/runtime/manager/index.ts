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
  Candidate,
  JsonObject,
  JsonValue,
} from '../../contracts/index.js';
import { RuntimeContext } from '../../contracts/runtime/context.js';
import { object, string, strings, digest } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { createCallExecutor } from './calls.js';
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
import { compilePolicy, type Policy } from '../compiler/index.js';
import {
  lockDefinition,
  restoreDefinition,
  parseLockedReflection,
  readResourceOrigins,
} from './definition-lock.js';
import {
  measurementItemsSchema,
  measurementEvidenceSchema,
  metricDefinitionSchema,
  validateMeasurement,
} from '../../contracts/models/measurement.js';
import { reflect } from '../revisions/index.js';
import type { ReflectionConfig } from '../revisions/validation.js';
import { acquireResourceGate } from '../revisions/exclusion.js';
import { RevisionApplication } from '../revisions/application.js';
import { projectEvidence } from '../services/facts/evidence.js';
import { projectEvidenceFiles } from '../services/facts/evidence-files.js';

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
  private readonly cleanupJobs = new Map<Promise<void>, number | undefined>();
  private readonly cleanupOwners = new Set<Instances>();
  async dispose(): Promise<void> {
    for (const c of this.running.values())
      c.abort(new Error('Runtime disposed'));
    await Promise.allSettled([...this.jobs]);
    // Observe existing disposal promises without invoking instance disposal again.
    await Promise.all(
      [...this.cleanupJobs].map(async ([job, reserve]) => {
        if (reserve === undefined) return job.catch(() => {});
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            job.catch(() => {}),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, reserve);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
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
      if (options.resume) {
        resumedRecord = await this.get(id);
        if (resumedRecord.recipePath !== resolve(recipePath))
          throw new Error(
            'Experiment recipePath differs from the saved Recipe',
          );
        const locked = await this.facts.read('definitions', id);
        if (locked.schemaVersion !== 'rsi.definition-lock/v1')
          throw new Error('Unsupported experiment definition lock');
        await restoreDefinition(
          locked,
          this.options.registry,
          this.artifacts,
          join(this.directory, 'experiments', id, 'resources'),
        );
        resourceOrigins = readResourceOrigins(locked);
        const lockedPolicy = compilePolicy(locked.policy, {
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
    const usage: Record<string, number> = {};
    const scopeUsage: Record<string, JsonObject> = {};
    let ledger = Promise.resolve();
    let initial: JsonObject = {};
    let policy: Policy;
    let bindings: Record<string, Binding> = {};
    let services: RuntimeContext;
    const reflectionModules = new Map<
      string,
      { config: ReflectionConfig; generatorBinding: string }
    >();
    const revisionRefs: JsonObject = {};
    const cleanupMs = recipe.budget.cleanupReserveMs;
    const unboundedCleanup = new AbortController().signal;
    let cleanupDeadline: number | undefined;
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
    this.cleanupOwners.add(instances);
    const charge = async (
      metric: string,
      amount: number,
      ctx: RuntimeContext,
    ): Promise<void> => {
      assertBusiness();
      if (!Number.isFinite(amount) || amount < 0)
        throw new Error('Invalid budget charge');
      const job = ledger.then(async () => {
        const next = (usage[metric] ?? 0) + amount;
        const limit = recipe.budget[metric];
        if (limit !== undefined && next > limit) {
          const error = new Error(`Budget exceeded: ${metric}`);
          error.name = 'ExperimentBudgetExceeded';
          failureCause = error;
          stopping.abort(error);
          throw error;
        }
        const scoped = ctx.scope;
        if (scoped) {
          const state = scopeUsage[scoped.id] ?? {};
          const count = Number(state[metric] ?? 0) + amount;
          const modelCalls = scoped.limits.modelCalls;
          if (
            metric === 'modelCalls' &&
            modelCalls !== undefined &&
            count > modelCalls
          )
            throw new Error('Reflection modelCalls budget exceeded');
          scopeUsage[scoped.id] = { ...state, [metric]: count };
        }
        usage[metric] = next;
        await this.facts.write('budgets', id, { ...usage, scopes: scopeUsage });
      });
      ledger = job.catch(() => {});
      await job;
    };
    const readCandidate = async (
      ref: string,
      ctx: RuntimeContext,
    ): Promise<Candidate> => {
      const candidate = await this.facts.read('candidates', ref);
      if (candidate.experimentId !== ctx.experimentId)
        throw new Error('Candidate belongs to another experiment');
      return {
        ref,
        artifactRef: string(candidate.artifactRef),
        parentRef:
          candidate.parentRef === null ? null : string(candidate.parentRef),
        experimentId: id,
      };
    };
    const readMeasurement = async (
      ref: string,
      ctx: RuntimeContext,
    ): Promise<JsonObject> => {
      const m = await this.facts.read('measurements', ref);
      if (m.experimentId !== ctx.experimentId)
        throw new Error('Measurement belongs to another experiment');
      validateMeasurement(m);
      return m;
    };
    const invoke = createCallExecutor({
      id,
      registry: this.options.registry,
      facts: this.facts,
      revisionRefs,
      context,
      binding: (name) =>
        name === '_application' ? recipe.application.toJSON() : bindings[name],
      operation: (bindingId, binding) => instances.acquire(bindingId, binding),
      charge,
      diagnose,
      onFailure: (error, caller) => {
        if (!caller.scope && !signal.aborted) {
          failureCause = error;
          stopping.abort(error);
        }
      },
    });
    const manager = this;
    services = (options.context ?? this.context).extend({
      experimentId: id,
      event: events.event,
      get signal() {
        return signal;
      },
      get cleanup() {
        if (cleanupMs === undefined) return unboundedCleanup;
        return AbortSignal.timeout(
          Math.max(
            1,
            cleanupDeadline === undefined
              ? cleanupMs
              : cleanupDeadline - Date.now(),
          ),
        );
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
        return readCandidate(ref, this);
      },
      async readMeasurement(this: RuntimeContext, ref) {
        return readMeasurement(ref, this);
      },
      async recordCandidate(this: RuntimeContext, artifactRef, parentRef) {
        const ctx = this;
        assertBusiness();
        if (parentRef) await readCandidate(parentRef, ctx);
        const ref =
          'candidate-' + digest({ id, artifactRef, parentRef }).slice(0, 32);
        await manager.facts.write('candidates', ref, {
          ref,
          artifactRef,
          parentRef,
          experimentId: id,
        });
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
        const owned: JsonObject = {
          ...measurement,
          experimentId: ctx.experimentId,
          callId: ctx.callId,
        };
        delete owned.ref;
        const ref = 'measurement-' + digest(owned);
        measurement.ref = ref;
        if (
          measurement.experimentId !== id ||
          measurement.callId !== ctx.callId
        )
          throw new Error('Invalid measurement ownership');
        measurement.evaluator = {
          ...object(measurement.evaluator),
          pluginId:
            bindings[ctx.bindingId]?.plugin ??
            object(measurement.evaluator).pluginId,
          implementationDigest: digest({
            adapter: object(measurement.evaluator).implementationDigest,
            registration: manager.options.registry.identity(
              string(object(measurement.evaluator).pluginId),
            ),
          }),
        };
        validateMeasurement(measurement);
        const checked = new Set<string>();
        const checkTypedArtifact = async (value: JsonValue): Promise<void> => {
          const descriptor = object(value);
          await manager.artifacts.readJson(string(descriptor.artifactRef));
        };
        const metrics = async (value: JsonValue): Promise<void> => {
          for (const raw of Object.values(object(value))) {
            const observation = object(raw),
              ref = string(observation.definitionRef);
            if (!checked.has(ref)) {
              validate(
                metricDefinitionSchema,
                await manager.artifacts.readJson(ref),
                'metric definition',
              );
              checked.add(ref);
            }
          }
        };
        for (const field of ['conditions', 'provenance', 'profile'])
          await checkTypedArtifact(measurement[field]!);
        if (Array.isArray(measurement.extensions))
          for (const value of measurement.extensions)
            await checkTypedArtifact(value);
        const items = await manager.artifacts.readJson(
          string(measurement.itemsRef),
        );
        validate(measurementItemsSchema, items, 'Measurement items');
        const entries = object(items).items;
        if (!Array.isArray(entries))
          throw new Error('Measurement items missing');
        for (const raw of entries) {
          const item = object(raw);
          await checkTypedArtifact(item.details!);
          if (item.evaluation !== null)
            await checkTypedArtifact(item.evaluation!);
          const subject = object(item.subject);
          if (subject.parameters !== null)
            await checkTypedArtifact(subject.parameters!);
          await metrics(item.metrics!);
          validate(
            measurementEvidenceSchema,
            await manager.artifacts.readJson(string(item.evidenceIndexRef)),
            'Item evidence',
          );
        }
        await metrics(measurement.metrics!);
        validate(
          measurementEvidenceSchema,
          await manager.artifacts.readJson(
            string(measurement.evidenceIndexRef),
          ),
          'Measurement evidence',
        );
        let prior: JsonObject | undefined;
        try {
          prior = await manager.facts.read('measurements', ref);
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
        if (prior && digest(prior) !== digest(measurement))
          throw new Error('Immutable Measurement cannot be overwritten');
        await manager.facts.write('measurements', ref, measurement);
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
          throw new Error('Application metadata belongs to another experiment');
        return {
          target: initial.target ?? null,
          capabilities: initial.capabilities ?? [],
          initialCandidateRef: initial.initialCandidateRef ?? null,
        };
      },
      async application(this: RuntimeContext, input) {
        return object(await invoke('_application', input, this));
      },
      async invoke(this: RuntimeContext, binding, input) {
        return invoke(binding, input, this);
      },
      async invokeAgent(this: RuntimeContext, input) {
        const ctx = this;
        const ref = string(input.agentRef ?? 'agent.default');
        if (!bindings[ref]) throw new Error(`Unknown Agent ${ref}`);
        return object(await invoke(ref, input, ctx));
      },
      async readEvidence(this: RuntimeContext, refs, options) {
        const ctx = this;
        const requestedBytes = options?.maxBytes;
        if (
          requestedBytes !== undefined &&
          (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0)
        )
          throw new Error(
            'readEvidence.maxBytes must be a positive safe integer',
          );
        const fileMode = options?.format === 'files';
        const evidenceLimit = Math.min(
          requestedBytes ?? Number.POSITIVE_INFINITY,
          ctx.scope?.limits.evidenceBytes ?? Number.POSITIVE_INFINITY,
        );
        const view = options?.view ?? 'execution';
        const measurements: JsonObject[] = [];
        const summaries: JsonValue[] = [];
        for (const ref of refs) {
          if (ref.startsWith('artifact:'))
            throw new Error(
              'Evidence requires an authorized reference, not an artifact',
            );
          const references = ref.startsWith('evidence-')
            ? await manager.facts.read('evidence-views', ref)
            : null;
          if (references && references.experimentId !== id)
            throw new Error('Evidence belongs to another experiment');
          if (references?.summary) summaries.push(references.summary);
          for (const measurementRef of references
            ? strings(references.measurementRefs)
            : [ref]) {
            const m = await readMeasurement(measurementRef, ctx);
            measurements.push(m);
          }
        }
        if (fileMode) {
          const result = await projectEvidenceFiles({
            measurements,
            artifacts: manager.artifacts,
            view,
            maxBytes: Number.isFinite(evidenceLimit)
              ? evidenceLimit
              : undefined,
          });
          if (summaries.length) {
            result.summaries = summaries;
            if (
              Number.isFinite(evidenceLimit) &&
              Buffer.byteLength(JSON.stringify(result)) > evidenceLimit
            )
              throw new Error('Full evidence context exceeds byte limit');
          }
          return result;
        }
        const maxBytes = Math.min(
          evidenceLimit,
          requestedBytes === undefined ? 60000 : 80000,
        );
        const result = await projectEvidence({
          measurements,
          artifacts: manager.artifacts,
          view,
          maxBytes: summaries.length
            ? Math.max(256, Math.floor(maxBytes * 0.7))
            : maxBytes,
        });
        const output = object(result);
        if (summaries.length) {
          const accepted: JsonValue[] = [];
          for (const summary of summaries) {
            if (
              Buffer.byteLength(
                JSON.stringify({ ...output, context: [...accepted, summary] }),
              ) > maxBytes
            ) {
              output.truncated = true;
              break;
            }
            accepted.push(summary);
          }
          output.context = accepted;
        }
        if (Buffer.byteLength(JSON.stringify(output)) > maxBytes)
          throw new Error('Evidence context exceeds byte limit');
        return output;
      },
      async withInstance(this: RuntimeContext, candidateRef, capability, use) {
        const ctx = this;
        const instanceId =
          'instance-' +
          digest({ callId: ctx.callId, candidateRef, capability }).slice(0, 32);
        let error: unknown;
        try {
          const acquire = object(
            await invoke(
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
            await invoke(
              '_application',
              { action: 'release', instanceId },
              cleanupContext,
              'release',
            );
          } catch (cleanupError) {
            await manager.facts.write('cleanup', instanceId, {
              experimentId: id,
              instanceId,
              status: 'unconfirmed',
              error: errorText(cleanupError),
            });
            if (error === undefined) throw cleanupError;
          }
        }
      },
    });
    const withinCleanup = async <T>(job: Promise<T>): Promise<T> => {
      if (cleanupMs === undefined) return job;
      const deadline = (cleanupDeadline ??= Date.now() + cleanupMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          job,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('Cleanup deadline exceeded')),
              Math.max(0, deadline - Date.now()),
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const drain = async (closeWhenIdle = false): Promise<void> => {
      do {
        await Promise.all([
          events.idle(),
          invoke.idle(),
          Promise.allSettled([...businessTasks]),
        ]);
      } while (events.pending || invoke.pending || businessTasks.size);
      if (closeWhenIdle) closeBusiness();
    };
    const closeBusiness = (): void => {
      acceptingBusiness = false;
      invoke.close();
    };
    const retire = (
      instance: Awaited<ReturnType<Instances['prepare']>>,
      cleanupId: string,
    ): void => {
      const job = instances.dispose(instance);
      this.cleanupJobs.set(job, cleanupMs);
      const timer =
        cleanupMs === undefined
          ? undefined
          : setTimeout(() => {
              events.abort(
                instance.scope,
                new Error('Instance cleanup deadline exceeded'),
              );
              void this.facts
                .write('cleanup', cleanupId, {
                  experimentId: id,
                  status: 'unconfirmed',
                  error: 'Instance cleanup deadline exceeded',
                })
                .catch(() => {});
            }, cleanupMs);
      void job
        .catch((error: unknown) =>
          this.facts.write('cleanup', cleanupId, {
            experimentId: id,
            status: 'unconfirmed',
            error: errorText(error),
          }),
        )
        .finally(() => {
          clearTimeout(timer);
          this.cleanupJobs.delete(job);
        })
        .catch(() => {});
    };
    const saveReflection = async (
      changes: Record<string, Binding>,
      revisions: JsonObject,
      activationId: string,
    ): Promise<void> => {
      const prepared = new Map<
        string,
        Awaited<ReturnType<Instances['prepare']>>
      >();
      const previous = new Map<
        string,
        Awaited<ReturnType<Instances['prepare']>>
      >();
      try {
        for (const [target, b] of Object.entries(changes)) {
          const definition = this.options.registry.get(b.plugin);
          validate(definition.configSchema, b.config, 'revision config');
          const current = await instances.currentInstance(target);
          if (current) {
            previous.set(target, current);
            prepared.set(target, await instances.prepare(target, b));
          }
        }
        await this.facts.write('activations', id, {
          activationId,
          bindings: object(
            JSON.parse(JSON.stringify({ ...bindings, ...changes })),
          ),
          revisions: { ...revisionRefs, ...revisions },
        });
      } catch (error) {
        for (const [target, instance] of prepared)
          retire(instance, `${activationId}-${target}-prepared`);
        throw error;
      }
      Object.assign(revisionRefs, revisions);
      for (const [target, b] of Object.entries(changes)) {
        bindings[target] = b;
        const replacement = prepared.get(target);
        if (replacement) instances.activate(target, replacement);
      }
      const refs: Record<string, string> = {};
      for (const [key, value] of Object.entries(revisions))
        if (typeof value === 'string') refs[key] = value;
      try {
        services.event.emit('rsi/revision-activated', {
          experimentId: id,
          activationId,
          bindingIds: Object.keys(changes),
          revisionRefs: refs,
        });
      } catch (error) {
        diagnose('rsi/revision-activated', error);
      }
      for (const [target, instance] of previous)
        retire(instance, `${activationId}-${target}`);
    };
    const runReflection = async (
      prefix: string,
      caller: RuntimeContext,
      stepPath: string,
      state: JsonObject,
      parallel: boolean,
    ): Promise<JsonValue> => {
      if (parallel)
        throw new Error(`${stepPath}: Reflection requires serial execution`);
      const module = reflectionModules.get(prefix);
      if (!module)
        throw new Error(
          `${stepPath}: Reflection module is not declared by this Policy`,
        );
      const ctx = caller;
      return reflect({
        config: module.config,
        invocation: {
          policyScopeId: prefix ? caller.callId : 'root',
          stepPath,
        },
        generatorBinding: module.generatorBinding,
        sourceResources: resourceOrigins,
        state,
        bindings,
        context: ctx,
        directory: this.directory,
        revisionRefs,
        getDefinition: (pluginId) => this.options.registry.get(pluginId),
        invoke: async (binding, value, key, scope) =>
          invoke(
            binding,
            value,
            ctx.extend({
              scope,
              signal: AbortSignal.any([ctx.signal, scope.signal]),
            }),
            key,
          ),
        save: saveReflection,
      });
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
      policy = recipe.policy;
      bindings = Object.fromEntries(
        Object.entries(recipe.bindings).map(([name, binding]) => [
          name,
          binding.toJSON(),
        ]),
      );
      if (recipe.reflection) {
        const config = structuredClone(recipe.reflection);
        const generatorBinding = '_reflection';
        bindings[generatorBinding] = {
          plugin: config.implementation.ref,
          config: config.implementation.config,
        };
        reflectionModules.set('', { config, generatorBinding });
      }
      for (const b of [
        recipe.application.toJSON(),
        ...Object.values(bindings),
      ]) {
        if (!registrations.has(b.plugin))
          registrations.set(b.plugin, this.options.registry.retain(b.plugin));
      }
      const reflectionConfiguration: JsonObject = Object.fromEntries(
        [...reflectionModules].map(([prefix, module]) => [
          prefix,
          { path: module.config.path, digest: module.config.digest },
        ]),
      );
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
      if (options.resume && (lockedReflection || reflectionModules.size)) {
        if (
          !lockedReflection ||
          lockedReflection.interface !== 'explicit-reflection/v1' ||
          digest(lockedReflection.configuration) !==
            digest(reflectionConfiguration)
        )
          throw new Error(
            'Reflection configuration source or contents differ from the locked experiment',
          );
      } else if (reflectionModules.size) {
        await this.facts.write('reflection-configs', id, {
          interface: 'explicit-reflection/v1',
          configuration: reflectionConfiguration,
        });
      }
      let restore: JsonObject | undefined;
      if (options.resume) {
        const legacyReflection = (await this.facts.list('reflection')).some(
          (fact) =>
            fact.experimentId === id &&
            fact.interface !== 'explicit-reflection/v1',
        );
        if (legacyReflection)
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
        try {
          restore = await this.facts.read('checkpoints', id);
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
        await this.facts.write('controls', id, {
          cancel: false,
          clearedAt: new Date().toISOString(),
        });
        const saved = await this.facts.read('budgets', id);
        for (const [k, v] of Object.entries(saved))
          if (typeof v === 'number') usage[k] = v;
        for (const [k, v] of Object.entries(object(saved.scopes ?? {})))
          scopeUsage[k] = object(v);
      }
      if (options.resume) {
        let activation: JsonObject | undefined;
        try {
          activation = await this.facts.read('activations', id);
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
        if (activation) {
          for (const [key, value] of Object.entries(
            object(activation.bindings),
          )) {
            const b = object(value);
            bindings[key] = {
              plugin: string(b.plugin),
              config: object(b.config),
            };
          }
          Object.assign(revisionRefs, object(activation.revisions));
        }
      }
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
            invoke(
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
        policy.execute({
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
          invoke: async (binding, value, path, parallel) =>
            invoke(binding, value, root, path, parallel),
          checkpoint: async (value) =>
            this.facts.write('checkpoints', id, value),
          reflect: (path, state, parallel) =>
            runReflection('', root, path, state, parallel),
        }),
      );
      await withinCleanup(drain(true));
      signal.throwIfAborted();
      if (failureCause !== undefined) throw failureCause;
      closeBusiness();
      const complete: JsonObject = {
        ...(await this.get(id)),
        status: 'succeeded',
        output: result,
        usage: { ...usage },
        durationMs: Date.now() - Date.parse(experimentStartedAt),
        finishedAt: new Date().toISOString(),
      };
      terminalSaveAttempted = true;
      await this.facts.write('experiments', id, complete);
      terminal = 'succeeded';
      return complete;
    } catch (error) {
      const wasCancelled = signal.aborted;
      stopping.abort(error);
      try {
        await withinCleanup(drain(true));
      } catch (cleanupError) {
        closeBusiness();
        events.abort(undefined, cleanupError);
        await invoke.unconfirmed();
        await this.facts.write('cleanup', id, {
          experimentId: id,
          status: 'unconfirmed',
          error: errorText(cleanupError),
        });
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
      terminalSaveAttempted = true;
      await this.facts.write('experiments', id, {
        ...previous,
        status,
        error: errorText(error),
        usage: { ...usage },
        finishedAt: new Date().toISOString(),
      });
      terminal = status;
      throw error;
    } finally {
      closeBusiness();
      let finalNotification: Promise<unknown> = Promise.resolve();
      if (terminal) {
        try {
          finalNotification = services.event
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
      const cleanup = (async (): Promise<void> => {
        await finalNotification;
        await drain();
        await instances.disposeAll();
        await events.dispose();
        await Promise.allSettled([...diagnostics]);
        for (const release of registrations.values()) release();
        await releaseLock();
        this.cleanupOwners.delete(instances);
      })();
      this.cleanupJobs.set(cleanup, cleanupMs);
      void cleanup.then(
        () => this.cleanupJobs.delete(cleanup),
        () => {},
      );
      try {
        await withinCleanup(cleanup);
      } catch (error) {
        events.abort(undefined, error);
        await this.facts.write('cleanup', id, {
          experimentId: id,
          status: 'unconfirmed',
          error: errorText(error),
        });
      }
    }
  }
}
