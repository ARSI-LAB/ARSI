import type {
  Binding,
  Operation,
  RuntimeContext,
  EventPipeline,
} from '../../contracts/index.js';
import type { Registry } from '../registry/index.js';
import type { EventScope, ManagedEvents } from '../services/events.js';

interface Instance {
  operation: Operation;
  scope: EventScope;
  uses: Set<Promise<unknown>>;
  disposal?: Promise<void>;
}
interface Entry {
  ready: Promise<Instance>;
  uses: Set<Promise<unknown>>;
}

/** Manager retains each instance until both calls and admitted listeners release it. */
export class Instances {
  private readonly current = new Map<string, Entry>();
  private readonly owned = new Set<Instance>();
  private readonly preparing = new Set<Promise<Instance>>();
  constructor(
    private readonly registry: Registry,
    private readonly events: ManagedEvents,
    private readonly context: (bindingId: string) => RuntimeContext,
  ) {}

  prepare(
    bindingId: string,
    binding: Binding,
    uses = new Set<Promise<unknown>>(),
  ): Promise<Instance> {
    const job = this.create(bindingId, binding, uses);
    this.preparing.add(job);
    void job.finally(() => this.preparing.delete(job)).catch(() => {});
    return job;
  }

  private async create(
    bindingId: string,
    binding: Binding,
    uses: Set<Promise<unknown>>,
  ): Promise<Instance> {
    const definition = this.registry.get(binding.plugin);
    const scope = this.events.prepare(bindingId);
    try {
      const operation = await definition.create(
        structuredClone(binding.config),
        this.context(bindingId).extend({ event: scope.event }),
      );
      const instance: Instance = { operation, scope, uses };
      this.owned.add(instance);
      return instance;
    } catch (error) {
      this.events.deactivate(scope);
      this.events.release(scope);
      throw error;
    }
  }

  activate(bindingId: string, instance: Instance): void {
    this.events.activate(instance.scope);
    this.current.set(bindingId, {
      ready: Promise.resolve(instance),
      uses: instance.uses,
    });
  }

  async acquire(
    bindingId: string,
    binding: Binding,
  ): Promise<{ operation: Operation; event: EventPipeline; release(): void }> {
    let entry = this.current.get(bindingId);
    if (!entry) {
      const uses = new Set<Promise<unknown>>();
      const prepared = this.prepare(bindingId, binding, uses);
      const created: Entry = {
        ready: prepared.then((instance) => {
          if (this.current.get(bindingId) === created)
            this.events.activate(instance.scope);
          return instance;
        }),
        uses,
      };
      entry = created;
      this.current.set(bindingId, entry);
    }
    let release!: () => void;
    const use = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Reserve before awaiting creation so a concurrent replacement cannot retire it.
    entry.uses.add(use);
    let instance: Instance;
    try {
      instance = await entry.ready;
    } catch (error) {
      entry.uses.delete(use);
      release();
      throw error;
    }
    return {
      operation: instance.operation,
      event: instance.scope.event,
      release: () => {
        instance.uses.delete(use);
        release();
      },
    };
  }

  async currentInstance(bindingId: string): Promise<Instance | undefined> {
    return this.current.get(bindingId)?.ready;
  }

  dispose(instance: Instance): Promise<void> {
    if (instance.disposal) return instance.disposal;
    this.events.deactivate(instance.scope);
    instance.disposal = (async () => {
      await this.events.idle(instance.scope);
      while (instance.uses.size) await Promise.allSettled([...instance.uses]);
      await instance.operation.dispose();
      this.events.release(instance.scope);
      this.owned.delete(instance);
    })();
    return instance.disposal;
  }

  async disposeAll(): Promise<void> {
    while (this.preparing.size) await Promise.allSettled([...this.preparing]);
    await Promise.allSettled(
      [...this.current.values()].map((entry) => entry.ready),
    );
    const results = await Promise.allSettled(
      [...this.owned].map((instance) => this.dispose(instance)),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Instance cleanup failed',
      );
  }
}
