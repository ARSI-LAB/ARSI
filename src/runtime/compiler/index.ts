import Ajv from 'ajv';
import { dirname, resolve } from 'node:path';
import type {
  JsonObject,
  JsonValue,
  PluginContract,
} from '../../contracts/index.js';
import { object, string, unknownKeys, digest } from '../../shared/json.js';
import { reflectionConfigFile } from '../revisions/declaration.js';
import { readPolicyDocument } from './document.js';
import { compileFlow, normalizeBranch } from './flow.js';
import { safeIdentifier } from './scope.js';

export interface ContractResolver {
  contract(id: string): PluginContract;
}

export interface CompiledPolicy {
  definition: JsonObject;
  directory: string;
  digest: string;
  require: Record<string, PluginContract>;
  defaults: JsonObject;
  stateSchema: JsonObject;
  usesReflection: boolean;
}

/** Child Policies that can reflect must not execute inside a concurrent branch. */
export function assertSerialReflectionDependencies(
  policy: CompiledPolicy,
  reflectedDependencies: ReadonlySet<string>,
): boolean {
  let callsReflection = false;
  function visitSteps(value: JsonValue, parallel: boolean, path: string): void {
    if (!Array.isArray(value)) return;
    for (const raw of value) {
      const step = object(raw);
      const label = `${path}.${string(step.id)}`;
      if (typeof step.use === 'string' && reflectedDependencies.has(step.use)) {
        callsReflection = true;
        if (parallel)
          throw new Error(
            `${String(policy.definition.id)} ${label}: parallel foreach cannot call a Policy that uses Reflection`,
          );
      }
      if (step.foreach !== undefined)
        visitSteps(
          step.steps ?? [],
          parallel ||
            (step.concurrency !== undefined && step.concurrency !== 1),
          label,
        );
      if (step.if !== undefined)
        for (const name of ['then', 'else'])
          visitSteps(
            normalizeBranch(step[name], label).steps ?? [],
            parallel,
            `${label}.${name}`,
          );
      if (step.loop !== undefined)
        visitSteps(object(step.loop).steps ?? [], parallel, `${label}.loop`);
    }
  }
  for (const stage of ['init', 'loop', 'finish'])
    if (policy.definition[stage] !== undefined)
      visitSteps(object(policy.definition[stage]).steps ?? [], false, stage);
  return callsReflection;
}

const schemaValidator = new Ajv.default({ strict: false, allErrors: true });

function validateSchema(value: JsonValue | undefined, label: string): void {
  const result = typeof value === 'boolean' ? value : object(value, label);
  if (!schemaValidator.validateSchema(result))
    throw new Error(
      `${label}: invalid schema: ${schemaValidator.errorsText()}`,
    );
}

function validatePolicy(policy: JsonObject): void {
  unknownKeys(
    policy,
    [
      'schemaVersion',
      'id',
      'description',
      'config_schema',
      'input_schema',
      'output_schema',
      'require',
      'defaults',
      'input',
      'init',
      'loop',
      'finish',
      'output',
    ],
    'policy',
  );
  if (policy.schemaVersion !== 'rsi.policy/v1')
    throw new Error('policy.schemaVersion: only rsi.policy/v1 is supported');
  string(policy.id, 'policy.id');
  if (policy.config_schema !== undefined)
    validateSchema(policy.config_schema, 'config_schema');
  validateSchema(policy.input_schema, 'input_schema');
  validateSchema(policy.output_schema, 'output_schema');
  if (object(policy.input_schema).type !== 'object')
    throw new Error('input_schema root must be object');
  if (policy.output === undefined) throw new Error('policy.output is required');
}

function resolveRequirements(
  policy: JsonObject,
  contracts: ContractResolver | undefined,
): Record<string, PluginContract> {
  const requirements = object(policy.require ?? {}, 'require');
  if (Object.hasOwn(requirements, 'reflection'))
    throw new Error(
      'require.reflection: name is reserved for the built-in Reflection module',
    );
  const require: Record<string, PluginContract> = {};
  for (const [name, raw] of Object.entries(requirements)) {
    if (!name.split('.').every((part) => safeIdentifier.test(part)))
      throw new Error(`Invalid dependency ${name}`);
    const requirement = object(raw, `require.${name}`);
    unknownKeys(requirement, ['contract'], `require.${name}`);
    const id = string(requirement.contract, `require.${name}.contract`);
    if (!contracts)
      throw new Error(
        `require.${name}: contract resolver is required for ${id}`,
      );
    try {
      require[name] = contracts.contract(id);
    } catch (error) {
      throw new Error(
        `require.${name}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return require;
}

function readDefaults(
  policy: JsonObject,
  require: Record<string, PluginContract>,
): JsonObject {
  const defaults = object(policy.defaults ?? {}, 'defaults');
  unknownKeys(defaults, ['bindings', 'reflection'], 'defaults');
  if (defaults.reflection !== undefined)
    reflectionConfigFile(defaults.reflection, 'defaults.reflection');
  for (const name of Object.keys(object(defaults.bindings ?? {})))
    if (!require[name])
      throw new Error(`Default binding ${name} is not declared in require`);
  return defaults;
}

export function compilePolicy(
  value: unknown,
  options: { directory?: string; contracts?: ContractResolver } = {},
): CompiledPolicy {
  const policy = object(structuredClone(value), 'policy');
  validatePolicy(policy);
  const require = resolveRequirements(policy, options.contracts);
  const defaults = readDefaults(policy, require);
  const { stateSchema, usesReflection } = compileFlow(policy, require);
  return {
    definition: policy,
    directory: resolve(options.directory ?? '.'),
    digest: digest({ policy, contracts: require }),
    require,
    defaults,
    stateSchema,
    usesReflection,
  };
}

export async function readPolicy(
  path: string,
  contracts: ContractResolver,
): Promise<CompiledPolicy> {
  return compilePolicy(await readPolicyDocument(path), {
    directory: dirname(resolve(path)),
    contracts,
  });
}
