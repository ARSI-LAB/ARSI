import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { lock } from 'proper-lockfile';
import { acquireResourceGate } from '../revisions/exclusion.js';
import type { FactStore } from '../../contracts/index.js';
import { errorText } from '../../shared/errors.js';
import type { ManagedEvents } from '../services/events.js';
import type { Instances } from './instances.js';
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
      if (errors.length)
        throw new AggregateError(errors, 'Experiment cleanup failed');
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
        await this.record(error);
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
