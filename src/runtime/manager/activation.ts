import { getLogger } from '@logtape/logtape';
import type {
  Binding,
  EventPipeline,
  FactStore,
  JsonObject,
} from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import type { Registry } from '../registry/index.js';
import type { Instances } from './instances.js';
import type { CleanupLifecycle } from './cleanup.js';

const logger = getLogger(['arsi', 'runtime', 'manager']);

type PreparedInstance = Awaited<ReturnType<Instances['prepare']>>;
interface Activation {
  activationId: string;
  bindings: Record<string, Binding>;
  revisions: JsonObject;
}
interface RevisionActivationOptions {
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
    activationId: string(value.activationId),
    bindings,
    revisions: object(value.revisions),
  };
}

/** Saves the replacement set before switching live instances and retiring prior owners. */
export class RevisionActivation {
  private readonly bindingState: Record<string, Binding>;
  private readonly revisionState: JsonObject = {};

  constructor(private readonly options: RevisionActivationOptions) {
    this.bindingState = structuredClone(options.bindings);
  }

  get bindings(): Readonly<Record<string, Binding>> {
    return this.bindingState;
  }

  get revisionRefs(): Readonly<JsonObject> {
    return this.revisionState;
  }

  /** All initial revision facts and resource snapshots must already be durable. */
  initialize(parents: JsonObject): void {
    for (const [target, parent] of Object.entries(parents))
      if (this.revisionState[target] === undefined)
        this.revisionState[target] = parent;
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
    const savedVersions = object(saved.bindingVersions ?? {});
    for (const [name, binding] of Object.entries(activation.bindings)) {
      if (
        this.options.bindingVersions &&
        savedVersions[name] !== this.options.bindingVersions?.[name]
      )
        continue;
      const ref = activation.revisions[name];
      if (
        !this.options.bindingVersions ||
        (typeof ref === 'string' &&
          (await this.options.facts.read('revisions', ref)).kind ===
            'generated')
      )
        this.bindingState[name] = binding;
      if (ref !== undefined) this.revisionState[name] = ref;
    }
  }

  async save(
    changes: Record<string, Binding>,
    revisions: JsonObject,
    activationId: string,
  ): Promise<void> {
    const { id, facts, registry, instances, cleanup, event, diagnose } =
      this.options;
    const prepared = new Map<string, PreparedInstance>();
    const previous = new Map<string, Promise<PreparedInstance>>();
    try {
      for (const [target, binding] of Object.entries(changes)) {
        const definition = registry.get(binding.plugin);
        validate(definition.configSchema, binding.config, 'revision config');
        prepared.set(target, await instances.prepare(target, binding));
      }
      await facts.write('activations', id, {
        activationId,
        bindings: object(structuredClone({ ...this.bindingState, ...changes })),
        revisions: { ...this.revisionState, ...revisions },
        ...(this.options.bindingVersions
          ? { bindingVersions: this.options.bindingVersions }
          : {}),
      });
    } catch (error) {
      for (const [target, instance] of prepared)
        cleanup.retire(instance, `${activationId}-${target}-prepared`);
      throw error;
    }
    Object.assign(this.revisionState, revisions);
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
