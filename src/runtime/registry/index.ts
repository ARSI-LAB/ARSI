import { Context } from '@deepseek-ai/cordis';
import type {
  JsonObject,
  JsonValue,
  Operation,
  OperationDefinition,
  RuntimeContext,
  DoctorContext,
} from '../../contracts/index.js';
import {
  defineContract,
  type PluginContract,
} from '../../contracts/contract.js';
import { validate } from '../../shared/schema.js';
import { json, digest } from '../../shared/json.js';

interface Registration {
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
  >(definition: OperationDefinition<I, O, C>): () => void {
    const unknown = Object.keys(definition).find(
      (key) =>
        ![
          'id',
          'description',
          'contract',
          'configSchema',
          'implementationDigest',
          'create',
          'doctor',
        ].includes(key),
    );
    if (unknown) throw new Error(`Plugin definition: unknown field ${unknown}`);
    if (
      definition.doctor !== undefined &&
      typeof definition.doctor !== 'function'
    )
      throw new Error(`Plugin ${definition.id}: doctor must be a function`);
    if (
      this.registrations.has(definition.id) ||
      this.policyFiles.has(definition.id)
    )
      throw new Error(`Duplicate ID ${definition.id}`);
    const contract = this.registerContract(definition.contract);
    const create = async (config: JsonObject, services: RuntimeContext) => {
      validate(definition.configSchema, config, 'plugin config');
      return definition.create(config as C, services);
    };
    const { doctor, ...capabilities } = definition;
    const registered: OperationDefinition = {
      ...capabilities,
      contract,
      ...(doctor
        ? {
            async doctor(context: DoctorContext): Promise<void> {
              validate(
                definition.configSchema,
                context.binding.config,
                'plugin doctor config',
              );
              await doctor.call(definition, {
                ...context,
                binding: {
                  name: context.binding.name,
                  pluginId: context.binding.pluginId,
                  definition: context.binding.definition,
                  config: context.binding.config as C,
                },
              });
            },
          }
        : {}),
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
          ...(operation.canRetry
            ? {
                canRetry: (input, receipt, context) =>
                  operation.canRetry!(input as I, receipt, context),
              }
            : {}),
          dispose: () => operation.dispose(),
        };
      },
    };
    const registration: Registration = {
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
    const fiber = this.context.plugin({
      name: definition.id,
      apply: (ctx: Context) => {
        ctx.provide(definition.id, registered);
        ctx.effect(() => () => {
          if (this.registrations.get(definition.id) === registration)
            this.registrations.delete(definition.id);
        });
      },
    });
    return () => {
      if (this.registrations.get(definition.id) !== registration) return;
      if (this.references.get(definition.id))
        throw new Error(`Plugin ${definition.id} is still in use`);
      this.registrations.delete(definition.id);
      void fiber.dispose();
    };
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
