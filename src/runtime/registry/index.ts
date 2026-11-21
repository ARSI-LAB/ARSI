import { managedAgentOperation } from '../services/agent-execution/task.js';
import { agentContract } from '../../contracts/plugin-types/agent.js';
import { Context } from '@deepseek-ai/cordis';
import type {
  JsonObject,
  JsonValue,
  Operation,
  OperationDefinition,
  OperationEventMap,
  OperationEvents,
  RuntimeContext,
} from '../../contracts/index.js';
import {
  defineContract,
  type PluginContract,
} from '../../contracts/contract.js';
import { validate } from '../../shared/schema.js';
import { json, digest } from '../../shared/json.js';

interface Registration {
  scope: Context;
  events: ReadonlySet<keyof OperationEventMap>;
  definition: OperationDefinition;
  createManaged(
    config: JsonObject,
    context: RuntimeContext,
  ): Promise<Operation>;
  implementationId: string;
}

export class Registry {
  readonly context = new Context();
  private readonly registrations = new Map<string, Registration>();
  private readonly policyFiles = new Map<string, string>();
  private readonly references = new Map<string, number>();
  private readonly contracts = new Map<string, PluginContract>();
  registerContract(value: PluginContract): PluginContract {
    const contract = defineContract(value);
    const previous = this.contracts.get(contract.id);
    if (previous && digest(previous) !== digest(contract))
      throw new Error(`Conflicting contract declaration ${contract.id}`);
    if (previous) return previous;
    this.contracts.set(contract.id, contract);
    return contract;
  }
  contract(id: string): PluginContract {
    const contract = this.contracts.get(id);
    if (!contract) throw new Error(`Unknown contract ${id}`);
    return contract;
  }
  assertContract(
    required: PluginContract,
    pluginId: string,
    binding: string,
  ): void {
    const actual = this.get(pluginId).contract;
    if (required.id !== actual.id || digest(required) !== digest(actual))
      throw new Error(
        `Binding ${binding}: requires contract ${required.id}, but ${pluginId} implements ${actual.id} with different type or schemas`,
      );
  }
  constructor() {
    this.context.provide('rsiRegistry', this);
  }
  retain(id: string): () => void {
    this.get(id);
    this.references.set(id, (this.references.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.references.set(id, (this.references.get(id) ?? 1) - 1);
    };
  }
  registerOperation<
    I extends JsonValue,
    O extends JsonValue,
    C extends JsonObject,
  >(
    definition: OperationDefinition<I, O, C>,
    subscribe?: (events: OperationEvents<C>) => void,
  ): () => void {
    const unknown = Object.keys(definition).find(
      (key) =>
        ![
          'id',
          'description',
          'contract',
          'configSchema',
          'implementationDigest',
          'create',
        ].includes(key),
    );
    if (unknown) throw new Error(`Plugin definition: unknown field ${unknown}`);
    if (
      this.registrations.has(definition.id) ||
      this.policyFiles.has(definition.id)
    )
      throw new Error(`Duplicate ID ${definition.id}`);
    const handlers: Partial<OperationEventMap<C>> = {};
    subscribe?.({
      on(name, handler) {
        if (typeof handler !== 'function' || handlers[name])
          throw new Error('Expected one handler for ' + name);
        handlers[name] = handler;
      },
    });
    const check = handlers['rsi/doctor'];
    if (check) {
      handlers['rsi/doctor'] = (context) => {
        validate(
          definition.configSchema,
          context.binding.config,
          'plugin doctor config',
        );
        return check(context);
      };
    }
    const contract = this.registerContract(definition.contract);
    const create = async (
      config: JsonObject,
      services: RuntimeContext,
    ): Promise<Operation> => {
      validate(definition.configSchema, config, 'plugin config');
      const operation = await definition.create(config as C, services);
      return contract.id === agentContract.id
        ? managedAgentOperation(operation)
        : operation;
    };
    const registered: OperationDefinition = {
      ...definition,
      contract,
      async create(config, services) {
        const operation = await create(config, services);
        return {
          async execute(input, context) {
            validate(contract.input_schema, input, 'plugin input');
            const output = await operation.execute(input as I, context);
            json(output);
            validate(contract.output_schema, output, 'plugin output');
            return output;
          },
          dispose: () => operation.dispose(),
        };
      },
    };
    const names = Object.keys(handlers) as (keyof OperationEventMap)[];
    const fiber = this.context.plugin({
      name: definition.id,
      apply: (ctx: Context) => {
        ctx.provide(definition.id, registered);
        for (const name of names) ctx.on(name, handlers[name]!);
        ctx.effect(() => () => {
          if (this.registrations.get(definition.id)?.scope.fiber === ctx.fiber)
            this.registrations.delete(definition.id);
        });
      },
    });
    const registration: Registration = {
      scope: fiber.ctx,
      events: new Set(names),
      definition: registered,
      createManaged: create,
      implementationId:
        definition.implementationDigest ??
        digest({
          factory: definition.create.toString(),
          contract,
          config: definition.configSchema,
        }),
    };
    this.registrations.set(definition.id, registration);
    return () => {
      if (this.registrations.get(definition.id) !== registration) return;
      if (this.references.get(definition.id))
        throw new Error(`Plugin ${definition.id} is still in use`);
      this.registrations.delete(definition.id);
      void fiber.dispose();
    };
  }
  handles(id: string, name: keyof OperationEventMap): boolean {
    return this.registration(id).events.has(name);
  }
  dispatch<K extends keyof OperationEventMap>(
    id: string,
    name: K,
    ...args: Parameters<OperationEventMap[K]>
  ): Promise<Awaited<ReturnType<OperationEventMap[K]>>>;
  async dispatch(
    id: string,
    name: keyof OperationEventMap,
    ...args: Parameters<OperationEventMap[keyof OperationEventMap]>
  ): Promise<Awaited<ReturnType<OperationEventMap[keyof OperationEventMap]>>> {
    const registration = this.registration(id);
    if (!registration.events.has(name))
      throw new Error('Plugin ' + id + ' has no handler for ' + name);
    const release = this.retain(id);
    try {
      // A caller may dispatch in the same turn that registered the Cordis plugin.
      await registration.scope.fiber.await();
      const target = {
        [Context.filter]: (ctx: Context) =>
          ctx.fiber === registration.scope.fiber,
      };
      return await this.context.serial(target, name, ...args);
    } finally {
      release();
    }
  }
  registerPolicy(id: string, path: string): void {
    if (this.registrations.has(id) || this.policyFiles.has(id))
      throw new Error(`Duplicate ID ${id}`);
    this.policyFiles.set(id, path);
  }
  get(id: string): OperationDefinition {
    return this.registration(id).definition;
  }
  /** Internal Manager factory: config is checked; CallExecutor owns IO validation and receipts. */
  createManagedOperation(
    id: string,
    config: JsonObject,
    context: RuntimeContext,
  ): Promise<Operation> {
    return this.registration(id).createManaged(config, context);
  }
  private registration(id: string): Registration {
    const registration = this.registrations.get(id);
    if (!registration) throw new Error(`Unknown plugin ${id}`);
    return registration;
  }
  policy(id: string): string {
    const path = this.policyFiles.get(id);
    if (!path) throw new Error(`Unknown policy ${id}`);
    return path;
  }
  catalog(): { plugins: string[]; policies: string[] } {
    return {
      plugins: [...this.registrations.keys()],
      policies: [...this.policyFiles.keys()],
    };
  }
  identity(id: string): string {
    const registration = this.registration(id);
    const d = registration.definition;
    return digest({
      id,
      contract: d.contract,
      config: d.configSchema,
      implementation: registration.implementationId,
    });
  }
  async dispose(): Promise<void> {
    if ([...this.references.values()].some((count) => count > 0))
      throw new Error('Runtime plugins are still in use');
    await this.context.fiber.dispose();
    this.registrations.clear();
    this.policyFiles.clear();
    this.contracts.clear();
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    rsiRegistry: Registry;
  }
}
