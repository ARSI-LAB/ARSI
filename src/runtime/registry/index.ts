import { Context } from '@deepseek-ai/cordis';
import type {
  JsonObject,
  JsonValue,
  OperationDefinition,
} from '../../contracts/index.js';
import {
  defineContract,
  type PluginContract,
} from '../../contracts/contract.js';
import { validate } from '../../shared/schema.js';
import { json, digest } from '../../shared/json.js';
export class Registry {
  readonly context = new Context();
  private readonly definitions = new Map<string, OperationDefinition>();
  private readonly policyFiles = new Map<string, string>();
  private readonly implementationIds = new Map<string, string>();
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
        ].includes(key),
    );
    if (unknown) throw new Error(`Plugin definition: unknown field ${unknown}`);
    if (
      this.definitions.has(definition.id) ||
      this.policyFiles.has(definition.id)
    )
      throw new Error(`Duplicate ID ${definition.id}`);
    const contract = this.registerContract(definition.contract);
    const registered: OperationDefinition = {
      ...definition,
      contract,
      async create(config, services) {
        validate(definition.configSchema, config, 'plugin config');
        const operation = await definition.create(config as C, services);
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
    this.definitions.set(definition.id, registered);
    this.implementationIds.set(
      definition.id,
      definition.implementationDigest ??
        digest({
          factory: definition.create.toString(),
          contract,
          config: definition.configSchema,
        }),
    );
    const fiber = this.context.plugin({
      name: definition.id,
      apply: (ctx: Context) => {
        ctx.provide(definition.id, registered);
        ctx.effect(() => () => {
          this.definitions.delete(definition.id);
        });
      },
    });
    return () => {
      if (this.references.get(definition.id))
        throw new Error(`Plugin ${definition.id} is still in use`);
      this.definitions.delete(definition.id);
      this.implementationIds.delete(definition.id);
      void fiber.dispose();
    };
  }
  registerPolicy(id: string, path: string): void {
    if (this.definitions.has(id) || this.policyFiles.has(id))
      throw new Error(`Duplicate ID ${id}`);
    this.policyFiles.set(id, path);
  }
  get(id: string): OperationDefinition {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`Unknown plugin ${id}`);
    return definition;
  }
  policy(id: string): string {
    const path = this.policyFiles.get(id);
    if (!path) throw new Error(`Unknown policy ${id}`);
    return path;
  }
  catalog(): { plugins: string[]; policies: string[] } {
    return {
      plugins: [...this.definitions.keys()],
      policies: [...this.policyFiles.keys()],
    };
  }
  identity(id: string): string {
    const d = this.get(id);
    return digest({
      id,
      contract: d.contract,
      config: d.configSchema,
      implementation: this.implementationIds.get(id)!,
    });
  }
  async dispose(): Promise<void> {
    if ([...this.references.values()].some((count) => count > 0))
      throw new Error('Runtime plugins are still in use');
    await this.context.fiber.dispose();
    this.policyFiles.clear();
    this.implementationIds.clear();
    this.contracts.clear();
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    rsiRegistry: Registry;
  }
}
