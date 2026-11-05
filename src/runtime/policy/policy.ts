import { dirname, resolve } from 'node:path';
import type {
  JsonObject,
  JsonSchema,
  JsonValue,
  RuntimeContext,
  PluginContract,
} from '../../contracts/index.js';
import {
  canonical,
  digest,
  object,
  string,
  unknownKeys,
} from '../../shared/json.js';
import { validate, validateSchemaDefinition } from '../../shared/schema.js';
import { readPolicyDocument } from '../compiler/document.js';
import { compileFlow } from '../compiler/flow.js';
import { reflectionConfigFile } from '../revisions/declaration.js';
import { reflectionResultSchema } from '../revisions/declaration.js';
import { evaluateTemplate } from './expression.js';
import { budgetSnapshotSchema } from '../../contracts/runtime/services.js';
import {
  immutable,
  parseSteps,
  safeIdentifier,
  type Step,
  type StepContext,
  type StepResult,
  type Template,
} from './steps.js';
export interface PolicyOptions {
  input?: JsonObject;
  config?: JsonObject;
  application: JsonObject;
  context: RuntimeContext;
  invoke(
    binding: string,
    input: JsonValue,
    stablePath: string,
    parallel: boolean,
  ): Promise<JsonValue>;
  reflect?(
    stablePath: string,
    state: JsonObject,
    parallel: boolean,
  ): Promise<JsonValue>;
  checkpoint(snapshot: JsonObject): Promise<void>;
  restore?: JsonObject;
  events?: {
    info: {
      experimentId: string;
      policyScopeId: string;
      checkpointRef: string;
    };
    diagnose(eventName: string, error: unknown): void;
  };
}
interface Frame {
  declared: ReadonlySet<string>;
  outputs: JsonObject;
}
interface Environment {
  frames: readonly Frame[];
  locals: JsonObject;
}
const checkpointVersion = 'rsi.policy-checkpoint/v1';
function changedFields(
  before: JsonObject,
  after: JsonObject,
  explicit: readonly string[] = [],
): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(after))
    if (
      explicit.includes(key) ||
      !Object.hasOwn(before, key) ||
      canonical(before[key]) !== canonical(value)
    )
      result[key] = structuredClone(value);
  return result;
}
function readRestore(
  value: JsonObject,
  identity: string,
): {
  journal: JsonObject;
  boundaries: JsonObject;
  budgetObservations: JsonObject;
} {
  if (value.schemaVersion !== checkpointVersion)
    throw new Error('Policy checkpoint format is unsupported');
  unknownKeys(
    value,
    [
      'schemaVersion',
      'identity',
      'journal',
      'boundaries',
      'budgetObservations',
    ],
    'Policy checkpoint',
  );
  if (value.identity !== identity)
    throw new Error('Policy checkpoint identity differs from locked inputs');
  const journal = structuredClone(object(value.journal, 'checkpoint.journal'));
  const boundaries = structuredClone(
    object(value.boundaries, 'checkpoint.boundaries'),
  );
  for (const [path, raw] of Object.entries(journal)) {
    if (!path.startsWith('steps/'))
      throw new Error(`checkpoint.journal: invalid step path ${path}`);
    const record = object(raw, `checkpoint.journal.${path}`);
    unknownKeys(record, ['result', 'patch'], `checkpoint.journal.${path}`);
    object(record.patch, 'checkpoint.patch');
    const result = object(record.result, 'checkpoint.result');
    if (result.kind === 'completed') {
      unknownKeys(result, ['kind', 'output'], 'checkpoint.result');
      if (result.output === undefined)
        throw new Error('checkpoint.result.output is required');
    } else if (result.kind === 'break' || result.kind === 'continue')
      unknownKeys(result, ['kind'], 'checkpoint.result');
    else throw new Error('checkpoint.result.kind is invalid');
  }
  for (const [path, complete] of Object.entries(boundaries))
    if (
      complete !== true ||
      (path !== 'policy-completed' && !/^steps\/.+\/iteration-\d+$/.test(path))
    )
      throw new Error(`checkpoint.boundaries: invalid boundary ${path}`);
  const budgetObservations = structuredClone(
    object(value.budgetObservations ?? {}, 'checkpoint.budgetObservations'),
  );
  for (const observation of Object.values(budgetObservations))
    validate(
      budgetSnapshotSchema,
      observation,
      'checkpoint.budgetObservations',
    );
  return { journal, boundaries, budgetObservations };
}
function stepResult(value: JsonValue): StepResult {
  const result = object(value, 'checkpoint.result');
  if (result.kind === 'completed')
    return { kind: 'completed', output: structuredClone(result.output!) };
  if (result.kind === 'break' || result.kind === 'continue')
    return { kind: result.kind };
  throw new Error('checkpoint.result.kind is invalid');
}

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
  return immutable(result);
}
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
    this.inputDefaults = immutable(
      object(policy.input === undefined ? {} : policy.input, 'policy.input'),
    );
    this.stateInitial = immutable(
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
        requirements[name] = immutable(
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
    this.defaults = immutable(
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
    this.output = immutable(policy.output);
    compileFlow(this);
    this.digest = digest({ policy: this.toJSON(), contracts: requirements });
    Object.freeze(this);
  }
  static fromJSON(value: unknown, options: CompilePolicyOptions = {}): Policy {
    return new Policy(value, options);
  }
  static async load(path: string, registry: ContractResolver): Promise<Policy> {
    return new Policy(await readPolicyDocument(path), {
      sourcePath: path,
      contracts: registry,
    });
  }
  /** Each execution owns its state, lexical frames, and durable progress. */
  async execute(options: PolicyOptions): Promise<JsonValue> {
    const policy = this;
    const signal = options.context.signal;
    signal.throwIfAborted();
    const application = immutable(
      structuredClone(object(options.application, 'application')),
    );
    const config = structuredClone(
      object(
        options.config === undefined ? {} : options.config,
        'policy.config',
      ),
    );
    validate(policy.configSchema, config, 'policy.config');
    immutable(config);
    const base = { application, config };
    const supplied = object(
      evaluateTemplate(options.input === undefined ? {} : options.input, base),
      'policy.input',
    );
    const missing = Object.fromEntries(
      Object.entries(policy.inputDefaults).filter(
        ([name]) => !Object.hasOwn(supplied, name),
      ),
    );
    const defaults = object(
      evaluateTemplate(missing, base),
      'policy.input defaults',
    );
    const input = structuredClone({ ...defaults, ...supplied });
    validate(policy.inputSchema, input, 'policy.input');
    immutable(input);
    let state = structuredClone(
      object(
        evaluateTemplate(policy.stateInitial, { ...base, input }),
        'policy.state',
      ),
    );
    validate(policy.stateSchema, state, 'policy.state');
    immutable(state);
    const identity = digest({
      policy: policy.digest,
      input,
      config,
      application,
    });
    const { journal, boundaries, budgetObservations } =
      options.restore === undefined
        ? { journal: {}, boundaries: {}, budgetObservations: {} }
        : readRestore(options.restore, identity);
    let queue = Promise.resolve();
    async function persist(): Promise<void> {
      const snapshot = structuredClone({
        schemaVersion: checkpointVersion,
        identity,
        journal,
        boundaries,
        budgetObservations,
      });
      queue = queue.then(async () => {
        signal.throwIfAborted();
        await options.checkpoint(snapshot);
        signal.throwIfAborted();
      });
      await queue;
    }
    // Observations are durable decisions, not reservations. Resuming an unfinished
    // container retains its admitted branch while new child steps read fresh usage.
    async function observeBudget(
      key: string,
      scope: Environment,
    ): Promise<void> {
      if (typeof options.context.readBudget !== 'function') return;
      if (!Object.hasOwn(budgetObservations, key)) {
        const snapshot = object(await options.context.readBudget());
        validate(budgetSnapshotSchema, snapshot, 'policy.budget');
        budgetObservations[key] = structuredClone(snapshot);
        await persist();
      }
      scope.locals.budget = immutable(
        structuredClone(budgetObservations[key]!),
      );
    }
    function updateState(patch: JsonObject, parallel: boolean): JsonObject {
      if (parallel)
        throw new Error('parallel execution cannot write shared state');
      const before = state;
      const proposed = structuredClone({ ...state, ...patch });
      validate(policy.stateSchema, proposed, 'policy.state');
      const committed = changedFields(before, proposed, Object.keys(patch));
      state = immutable(proposed);
      return committed;
    }
    const eventInfo = options.events && {
      ...options.events.info,
      policyId: policy.id,
    };
    function notify(eventName: string, publish: () => void): void {
      try {
        publish();
      } catch (error) {
        options.events!.diagnose(eventName, error);
      }
    }
    async function boundary(path?: string, iteration?: number): Promise<void> {
      signal.throwIfAborted();
      const key =
        path === undefined
          ? 'policy-completed'
          : `${path}/iteration-${iteration}`;
      if (Object.hasOwn(boundaries, key)) return;
      boundaries[key] = true;
      await persist();
      if (eventInfo)
        await options.context.event.serial('rsi/policy-boundary-completed', {
          ...eventInfo,
          boundary:
            path === undefined ? 'policy-completed' : 'iteration-completed',
          ...(path === undefined ? {} : { stepPath: path, iteration }),
        });
      signal.throwIfAborted();
    }
    function environment(
      scope: Environment,
      extra: JsonObject = {},
    ): JsonObject {
      const outputs: JsonObject = {};
      for (const frame of scope.frames) {
        for (const name of frame.declared) delete outputs[name];
        Object.assign(outputs, frame.outputs);
      }
      return {
        ...base,
        input,
        state,
        steps: outputs,
        ...scope.locals,
        ...extra,
      };
    }
    function evaluate(
      template: Template,
      scope: Environment,
      extra?: JsonObject,
    ): JsonValue {
      return structuredClone(
        evaluateTemplate(template, environment(scope, extra)),
      );
    }
    async function runStep(
      step: Step,
      scope: Environment,
      path: string,
      parallel: boolean,
    ): Promise<StepResult> {
      signal.throwIfAborted();
      const stepPath = `${path}/${step.id}`;
      scope = { ...scope, locals: { ...scope.locals } };
      let result: StepResult;
      if (Object.hasOwn(journal, stepPath)) {
        const record = object(journal[stepPath]);
        const patch = object(record.patch);
        if (Object.keys(patch).length) updateState(patch, parallel);
        result = stepResult(record.result!);
      } else {
        await observeBudget(`step:${stepPath}`, scope);
        const before = state;
        const context: StepContext = {
          input,
          config,
          application,
          get state() {
            return state;
          },
          signal,
          stepPath,
          parallel,
          evaluate(template, locals) {
            return evaluate(template, scope, locals);
          },
          async invoke(binding, payload) {
            signal.throwIfAborted();
            const contract = policy.requirements[binding];
            if (!contract)
              throw new Error(`${stepPath}: undeclared dependency ${binding}`);
            const ownedInput = structuredClone(payload);
            validate(contract.input_schema, ownedInput, `${binding}.input`);
            const value = await options.invoke(
              binding,
              ownedInput,
              stepPath,
              parallel,
            );
            signal.throwIfAborted();
            const ownedOutput = structuredClone(value);
            validate(contract.output_schema, ownedOutput, `${binding}.output`);
            return ownedOutput;
          },
          updateState(patch) {
            signal.throwIfAborted();
            return updateState(patch, parallel);
          },
          async reflect() {
            if (parallel)
              throw new Error(
                `${stepPath}: Reflection requires serial execution`,
              );
            if (!policy.defaults.reflection || !options.reflect)
              throw new Error(`${stepPath}: Reflection is not configured`);
            signal.throwIfAborted();
            const value = structuredClone(
              await options.reflect(stepPath, structuredClone(state), parallel),
            );
            signal.throwIfAborted();
            validate(reflectionResultSchema, value, 'reflection.output');
            return value;
          },
          runSteps(children, settings) {
            return runSteps(
              children,
              {
                frames: scope.frames,
                locals: { ...scope.locals, ...settings.locals },
              },
              `${stepPath}/${settings.scope}`,
              parallel || (settings.parallel ?? false),
              settings.output,
            );
          },
          observeBudget(key) {
            return observeBudget(`${key}:${stepPath}`, scope);
          },
          boundary(iteration) {
            return boundary(stepPath, iteration);
          },
        };
        result = await step.execute(context);
        signal.throwIfAborted();
        journal[stepPath] = {
          result: structuredClone(result),
          patch: changedFields(before, state),
        };
        await persist();
        if (eventInfo)
          notify('rsi/policy-step-completed', () =>
            options.context.event.emit('rsi/policy-step-completed', {
              ...eventInfo,
              stepPath,
            }),
          );
      }
      return result;
    }
    async function runSteps(
      steps: readonly Step[],
      inherited: Environment,
      path: string,
      parallel: boolean,
      output: Template = null,
    ): Promise<StepResult> {
      const frame: Frame = {
        declared: new Set(steps.map((step) => step.id)),
        outputs: {},
      };
      const scope: Environment = {
        ...inherited,
        frames: [...inherited.frames, frame],
      };
      for (const step of steps) {
        const result = await runStep(step, scope, path, parallel);
        if (result.kind !== 'completed') return result;
        frame.outputs[step.id] = immutable({
          output: structuredClone(result.output),
        });
      }
      signal.throwIfAborted();
      await observeBudget(`output:${path}`, scope);
      return { kind: 'completed', output: evaluate(output, scope) };
    }
    if (eventInfo)
      await options.context.event.serial('rsi/policy-started', {
        ...eventInfo,
        resumed: options.restore !== undefined,
      });
    signal.throwIfAborted();
    const result = await runSteps(
      policy.steps,
      { frames: [], locals: {} },
      'steps',
      false,
      policy.output,
    );
    if (result.kind !== 'completed')
      throw new Error('Policy control escaped its loop');
    await boundary();
    signal.throwIfAborted();
    const output = structuredClone(result.output);
    validate(policy.outputSchema, output, 'policy.output');
    if (eventInfo)
      notify('rsi/policy-completed', () =>
        options.context.event.emit('rsi/policy-completed', eventInfo),
      );
    return output;
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
export function compilePolicy(
  value: unknown,
  options: CompilePolicyOptions = {},
): Policy {
  return Policy.fromJSON(value, options);
}
export async function readPolicy(
  path: string,
  registry: ContractResolver,
): Promise<Policy> {
  return Policy.load(path, registry);
}
