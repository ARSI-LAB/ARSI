import { getLogger } from '@logtape/logtape';
import { persistFact } from '../storage/persistence-error.js';
import { parseActiveMemory, type ActiveMemory } from '../evolution/memory.js';
import type {
  Binding,
  EventPipeline,
  FactStore,
  JsonObject,
} from '../../contracts/index.js';
import { canonical, object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import type { Registry } from '../registry/index.js';
import type { Instances } from './instances.js';
import type { CleanupLifecycle } from './cleanup.js';

const logger = getLogger(['arsi', 'runtime', 'manager']);

type PreparedInstance = Awaited<ReturnType<Instances['prepare']>>;
interface Activation {
  reflectionRevisionRef: string | null;
  memory: ActiveMemory | null;
  activationId: string;
  bindings: Record<string, Binding>;
  revisions: JsonObject;
}
interface RuntimeEvolutionActivationOptions {
  id: string;
  bindings: Record<string, Binding>;
  facts: FactStore;
  registry: Registry;
  instances: Instances;
  cleanup: CleanupLifecycle;
  event: EventPipeline;
  bindingVersions?: JsonObject;
  diagnose(event: string, error: unknown): void;
}

function parseActivation(value: JsonObject): Activation {
  const bindings: Record<string, Binding> = {};
  for (const [id, entry] of Object.entries(object(value.bindings))) {
    const binding = object(entry);
    bindings[id] = {
      plugin: string(binding.plugin),
      config: object(binding.config),
    };
  }
  return {
    reflectionRevisionRef:
      value.reflectionRevisionRef == null
        ? null
        : string(value.reflectionRevisionRef),
    activationId: string(value.activationId),
    bindings,
    memory: value.memory ? parseActiveMemory(value.memory) : null,
    revisions: object(value.revisions),
  };
}

/** Saves the replacement set before switching live instances and retiring prior owners. */
export class RuntimeEvolutionActivation {
  private readonly bindingState: Record<string, Binding>;
  private readonly revisionState: JsonObject = {};
  private reflectionHead: string | null = null;

  private memoryState: ActiveMemory | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly options: RuntimeEvolutionActivationOptions) {
    this.bindingState = structuredClone(options.bindings);
  }

  get memory(): ActiveMemory | null {
    return this.memoryState;
  }

  get reflectionRevisionRef(): string | null {
    return this.reflectionHead;
  }
  get summary(): JsonObject {
    return {
      memoryRef: this.memoryState?.ref ?? null,
      memoryArtifactRef: this.memoryState?.artifactRef ?? null,
      revisionRefs: { ...this.revisionState },
    };
  }
  private serialize(write: () => Promise<void>): Promise<void> {
    const result = this.writes.then(write);
    this.writes = result.catch(() => {});
    return result;
  }
  initializeMemory(memory: ActiveMemory): Promise<void> {
    // The seed establishes the starting version before experiment lifecycle events.
    return this.serialize(() => this.persistMemory(memory, memory.ref));
  }
  private async persistMemory(
    memory: ActiveMemory,
    activationId: string,
  ): Promise<void> {
    await this.persist(
      activationId,
      this.bindingState,
      this.revisionState,
      memory,
    );
    this.memoryState = memory;
  }
  saveMemory(memory: ActiveMemory, activationId: string): Promise<void> {
    return this.serialize(async () => {
      await this.persistMemory(memory, activationId);
      try {
        this.options.event.emit('rsi/memory-activated', {
          experimentId: this.options.id,
          activationId,
          memoryVersionRef: memory.ref,
          artifactRef: memory.artifactRef,
        });
      } catch (error) {
        this.options.diagnose('rsi/memory-activated', error);
      }
    });
  }
  private async persist(
    activationId: string,
    bindings: Record<string, Binding>,
    revisions: JsonObject,
    memory: ActiveMemory | null,
    reflectionRevisionRef = this.reflectionHead,
  ): Promise<void> {
    const record = {
      activationId,
      bindings: object(structuredClone(bindings)),
      revisions: { ...revisions },
      reflectionRevisionRef,
      memory,
      ...(this.options.bindingVersions
        ? { bindingVersions: this.options.bindingVersions }
        : {}),
    };
    const { facts, id } = this.options;
    try {
      await persistFact(facts, 'activations', id, record);
    } catch (error) {
      // A storage adapter can lose the acknowledgement after publishing the pointer.
      const published = await facts.read('activations', id).catch(() => null);
      if (!published || canonical(published) !== canonical(record)) throw error;
    }
  }

  get bindings(): Readonly<Record<string, Binding>> {
    return this.bindingState;
  }

  get revisionRefs(): Readonly<JsonObject> {
    return this.revisionState;
  }

  /** Publish the baseline after its complete resource snapshot is durable. */
  initialize(parents: JsonObject, head: string): Promise<void> {
    return this.serialize(async () => {
      if (this.reflectionHead === head) return;
      await this.persist(
        head,
        this.bindingState,
        { ...this.revisionState, ...parents },
        this.memoryState,
        head,
      );
      Object.assign(this.revisionState, parents);
      this.reflectionHead = head;
    });
  }

  async restore(): Promise<void> {
    let saved: JsonObject;
    try {
      saved = await this.options.facts.read('activations', this.options.id);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return;
      throw error;
    }
    const activation = parseActivation(saved);
    this.memoryState = activation.memory;
    const savedVersions = object(saved.bindingVersions ?? {});
    let incompatible = false;
    for (const [name, binding] of Object.entries(activation.bindings)) {
      if (
        this.options.bindingVersions &&
        savedVersions[name] !== this.options.bindingVersions?.[name]
      ) {
        if (Object.hasOwn(activation.revisions, name)) {
          incompatible = true;
          delete this.revisionState[name];
        }
        continue;
      }
      const ref = activation.revisions[name];
      if (
        !this.options.bindingVersions ||
        (typeof ref === 'string' &&
          (activation.reflectionRevisionRef !== null ||
            (await this.options.facts.read('revisions', ref)).kind ===
              'generated'))
      )
        this.bindingState[name] = binding;
      if (ref !== undefined) this.revisionState[name] = ref;
    }
    this.reflectionHead = incompatible
      ? null
      : activation.reflectionRevisionRef;
    if (incompatible)
      await this.persist(
        activation.activationId,
        this.bindingState,
        this.revisionState,
        this.memoryState,
      );
  }

  saveRevisions(
    changes: Record<string, Binding>,
    revisions: JsonObject,
    activationId: string,
    head: string,
  ): Promise<void> {
    return this.serialize(() =>
      this.replace(changes, revisions, activationId, head),
    );
  }
  private async replace(
    changes: Record<string, Binding>,
    revisions: JsonObject,
    activationId: string,
    head: string,
  ): Promise<void> {
    const { id, registry, instances, cleanup, event, diagnose } = this.options;
    const prepared = new Map<string, PreparedInstance>();
    const previous = new Map<string, Promise<PreparedInstance>>();
    try {
      for (const [target, binding] of Object.entries(changes)) {
        const definition = registry.get(binding.plugin);
        validate(definition.configSchema, binding.config, 'revision config');
        prepared.set(target, await instances.prepare(target, binding));
      }
      await this.persist(
        activationId,
        { ...this.bindingState, ...changes },
        { ...this.revisionState, ...revisions },
        this.memoryState,
        head,
      );
    } catch (error) {
      for (const [target, instance] of prepared)
        cleanup.retire(instance, `${activationId}-${target}-prepared`);
      throw error;
    }
    Object.assign(this.revisionState, revisions);
    this.reflectionHead = head;
    for (const [target, binding] of Object.entries(changes)) {
      this.bindingState[target] = binding;
      const prior = instances.activate(target, prepared.get(target)!);
      if (prior) previous.set(target, prior);
    }
    const refs: Record<string, string> = {};
    for (const [key, value] of Object.entries(revisions))
      if (typeof value === 'string') refs[key] = value;
    logger.info('revision {activationId} ({bindings})', {
      stage: 'Activated',
      experimentId: id,
      activationId,
      bindings: Object.keys(changes).join(', '),
      revisionRefs: refs,
    });
    try {
      event.emit('rsi/revision-activated', {
        experimentId: id,
        activationId,
        bindingIds: Object.keys(changes),
        revisionRefs: refs,
      });
    } catch (error) {
      diagnose('rsi/revision-activated', error);
    }
    for (const [target, ready] of previous)
      void ready.then(
        (instance) => cleanup.retire(instance, `${activationId}-${target}`),
        () => {}, // Failed creation already released its event scope.
      );
  }
}
