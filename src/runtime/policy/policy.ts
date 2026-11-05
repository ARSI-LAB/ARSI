import { dirname, resolve } from 'node:path';
import type {
  JsonObject,
  JsonValue,
  JsonSchema,
  PluginContract,
} from '../../contracts/index.js';
import {
  digest,
  object,
  string,
  unknownKeys,
  freezeSnapshot,
} from '../../shared/json.js';
import { validateSchemaDefinition } from '../../shared/schema.js';
import { compileFlow } from '../compiler/flow.js';
import { readPolicyDocument } from '../compiler/document.js';
import { runPolicy, type PolicyExecutionOptions } from './executor.js';
import { reflectionConfigFile } from '../revisions/declaration.js';
import {
  parseSteps,
  safeIdentifier,
  type Step,
  type Template,
} from './steps.js';
export interface ContractResolver {
  contract(id: string): PluginContract;
}
export interface CompilePolicyOptions {
  directory?: string;
  contracts?: ContractResolver;
  sourcePath?: string;
}
const emptyObjectSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
};
function schema(value: unknown, label: string, objectRoot = false): JsonSchema {
  const result = typeof value === 'boolean' ? value : object(value, label);
  validateSchemaDefinition(result, label);
  if (objectRoot && (typeof result === 'boolean' || result.type !== 'object'))
    throw new Error(`${label} root must be object`);
  return freezeSnapshot(result);
}
/** Immutable validated declaration with a fresh execution environment for each run. */
export class Policy {
  readonly id: string;
  readonly description?: string;
  readonly sourcePath: string;
  readonly directory: string;
  readonly inputSchema: JsonSchema;
  readonly configSchema: JsonSchema;
  readonly stateSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly inputDefaults: JsonObject;
  readonly stateInitial: JsonObject;
  readonly requirements: Readonly<Record<string, PluginContract>>;
  readonly defaults: JsonObject;
  readonly steps: readonly Step[];
  readonly output: Template;
  readonly digest: string;

  constructor(value: unknown, options: CompilePolicyOptions = {}) {
    const policy = object(structuredClone(value), 'policy');
    unknownKeys(
      policy,
      [
        'schemaVersion',
        'id',
        'description',
        'input_schema',
        'input',
        'config_schema',
        'state_schema',
        'state',
        'output_schema',
        'require',
        'defaults',
        'steps',
        'output',
      ],
      'policy',
    );
    if (policy.schemaVersion !== 'rsi.policy/v1')
      throw new Error('policy.schemaVersion: only rsi.policy/v1 is supported');
    this.id = string(policy.id, 'policy.id');
    if (policy.description !== undefined)
      this.description = string(policy.description, 'policy.description');
    this.sourcePath = resolve(
      options.sourcePath ?? resolve(options.directory ?? '.', 'policy.yaml'),
    );
    this.directory = resolve(options.directory ?? dirname(this.sourcePath));
    this.inputSchema = schema(policy.input_schema, 'input_schema', true);
    this.configSchema = schema(
      policy.config_schema === undefined
        ? structuredClone(emptyObjectSchema)
        : policy.config_schema,
      'config_schema',
      true,
    );
    if (policy.state !== undefined && policy.state_schema === undefined)
      throw new Error(
        'state_schema is required when initial state is declared',
      );
    this.stateSchema = schema(
      policy.state_schema === undefined
        ? structuredClone(emptyObjectSchema)
        : policy.state_schema,
      'state_schema',
      true,
    );
    this.outputSchema = schema(policy.output_schema, 'output_schema');
    this.inputDefaults = freezeSnapshot(
      object(policy.input === undefined ? {} : policy.input, 'policy.input'),
    );
    this.stateInitial = freezeSnapshot(
      object(policy.state === undefined ? {} : policy.state, 'policy.state'),
    );
    const requirements: Record<string, PluginContract> = {};
    for (const [name, raw] of Object.entries(
      object(policy.require === undefined ? {} : policy.require, 'require'),
    )) {
      if (
        !name.split('.').every((part) => safeIdentifier.test(part)) ||
        name === 'reflection'
      )
        throw new Error(`require: invalid or reserved dependency ${name}`);
      const entry = object(raw, `require.${name}`);
      unknownKeys(entry, ['contract'], `require.${name}`);
      const contractId = string(entry.contract, `require.${name}.contract`);
      if (!options.contracts)
        throw new Error(
          `require.${name}: contract resolver is required for ${contractId}`,
        );
      try {
        requirements[name] = freezeSnapshot(
          structuredClone(options.contracts.contract(contractId)),
        );
      } catch (error) {
        throw new Error(
          `require.${name}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    this.requirements = Object.freeze(requirements);
    this.defaults = freezeSnapshot(
      object(policy.defaults === undefined ? {} : policy.defaults, 'defaults'),
    );
    unknownKeys(this.defaults, ['bindings', 'reflection'], 'defaults');
    if (this.defaults.reflection !== undefined)
      reflectionConfigFile(this.defaults.reflection, 'defaults.reflection');
    for (const [name, raw] of Object.entries(
      object(
        this.defaults.bindings === undefined ? {} : this.defaults.bindings,
        'defaults.bindings',
      ),
    )) {
      if (!Object.hasOwn(requirements, name))
        throw new Error(`Default binding ${name} is not declared in require`);
      const binding = object(raw, `defaults.bindings.${name}`);
      unknownKeys(binding, ['plugin', 'config'], `defaults.bindings.${name}`);
      if (binding.plugin !== undefined)
        string(binding.plugin, `defaults.bindings.${name}.plugin`);
      if (binding.config !== undefined)
        object(binding.config, `defaults.bindings.${name}.config`);
    }
    this.steps = parseSteps(policy.steps, 'policy');
    if (policy.output === undefined)
      throw new Error('policy.output is required');
    this.output = freezeSnapshot(policy.output);
    compileFlow(this);
    this.digest = digest({ policy: this.toJSON(), contracts: requirements });
    Object.freeze(this);
  }

  static async load(path: string, registry: ContractResolver): Promise<Policy> {
    return new Policy(await readPolicyDocument(path), {
      sourcePath: path,
      contracts: registry,
    });
  }

  async execute(options: PolicyExecutionOptions): Promise<JsonValue> {
    return runPolicy(this, options);
  }

  toJSON(): JsonObject {
    return structuredClone({
      schemaVersion: 'rsi.policy/v1',
      id: this.id,
      ...(this.description === undefined
        ? {}
        : { description: this.description }),
      input_schema: this.inputSchema,
      config_schema: this.configSchema,
      state_schema: this.stateSchema,
      output_schema: this.outputSchema,
      input: this.inputDefaults,
      state: this.stateInitial,
      require: Object.fromEntries(
        Object.entries(this.requirements).map(([name, contract]) => [
          name,
          { contract: contract.id },
        ]),
      ),
      defaults: this.defaults,
      steps: this.steps.map((step) => step.toJSON()),
      output: this.output,
    });
  }
}
