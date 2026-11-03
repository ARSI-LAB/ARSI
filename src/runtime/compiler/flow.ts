import type {
  JsonObject,
  JsonValue,
  PluginContract,
} from '../../contracts/index.js';
import { object, string, unknownKeys } from '../../shared/json.js';
import { reflectionResultSchema } from '../revisions/declaration.js';
import {
  compileExpression,
  expressionPaths,
  expressions,
} from '../policy/expression.js';
import { inferSchema, mergeSchemas } from './schema-inference.js';
import {
  cloneScope,
  safeIdentifier,
  scopeRoots,
  validateTemplate,
  type Scope,
} from './scope.js';

export function normalizeBranch(
  value: JsonValue | undefined,
  label: string,
): JsonObject {
  if (value === undefined) return { steps: [] };
  if (Array.isArray(value)) return { steps: value };
  const result = object(value, label);
  unknownKeys(result, ['steps', 'yield'], label);
  return result;
}

interface CompiledFlow {
  stateSchema: JsonObject;
  usesReflection: boolean;
}

export function compileFlow(
  policy: JsonObject,
  require: Record<string, PluginContract>,
): CompiledFlow {
  return new FlowCompiler(policy, require).compile();
}

class FlowCompiler {
  private readonly states: Record<string, JsonObject> = {};
  private usesReflection = false;

  constructor(
    private readonly policy: JsonObject,
    private readonly require: Record<string, PluginContract>,
  ) {}

  compile(): CompiledFlow {
    const policy = this.policy;
    const initial: Scope = {
      initialized: new Set(),
      available: { init: new Set(), loop: new Set(), finish: new Set() },
      types: {
        config: object(
          policy.config_schema ?? {
            type: 'object',
            additionalProperties: false,
          },
        ),
        input: object(policy.input_schema),
        application: { type: 'object' },
        state: { type: 'object', properties: this.states },
      },
      parallel: false,
      loopDepth: 0,
    };
    if (policy.input !== undefined) {
      object(policy.input, 'policy.input defaults');
      validateTemplate(policy.input, initial, 'input', [
        'application',
        'config',
      ]);
    }
    for (const stage of ['init', 'finish'])
      if (policy[stage] !== undefined)
        unknownKeys(object(policy[stage]), ['steps'], stage);
    this.compileSteps(
      object(policy.init ?? {}).steps ?? [],
      initial,
      'init',
      'init',
    );
    if (policy.loop !== undefined)
      this.compileMainLoop(object(policy.loop), initial);
    this.compileSteps(
      object(policy.finish ?? {}).steps ?? [],
      initial,
      'finish',
      'finish',
    );
    validateTemplate(policy.output, initial, 'output');
    return {
      stateSchema: {
        type: 'object',
        properties: this.states,
        additionalProperties: false,
      },
      usesReflection: this.usesReflection,
    };
  }

  private compileLoop(block: JsonObject, scope: Scope, path: string): void {
    unknownKeys(block, ['maxIterations', 'while', 'steps', 'output'], path);
    if (block.maxIterations === undefined)
      throw new Error(`${path}.maxIterations is required`);
    validateTemplate(block.maxIterations, scope, path);
    if (
      typeof block.maxIterations === 'number' &&
      (!Number.isInteger(block.maxIterations) ||
        block.maxIterations < 0 ||
        block.maxIterations > 100000)
    )
      throw new Error(`${path}: invalid iteration limit`);
    const body = cloneScope(scope);
    body.loopDepth++;
    body.types.loop = {
      type: 'object',
      properties: { index: { type: 'integer' }, input: { type: 'object' } },
    };
    body.available.loop = new Set();
    if (block.while !== undefined) validateTemplate(block.while, body, path);
    this.compileSteps(block.steps ?? [], body, 'loop', path);
    if (block.output !== undefined) validateTemplate(block.output, body, path);
  }

  private compileSteps(
    value: JsonValue,
    scope: Scope,
    stage: string,
    path: string,
  ): void {
    if (!Array.isArray(value))
      throw new Error(`${path}.steps must be an array`);
    const ids = new Set<string>();
    let terminated = false;
    for (const raw of value) {
      const step = object(raw, `${path}.step`);
      const id = string(step.id, `${path}.step.id`);
      if (
        !safeIdentifier.test(id) ||
        ids.has(id) ||
        (stage === 'loop' && ['index', 'input'].includes(id))
      )
        throw new Error(`${path}: duplicate or unsafe step id ${id}`);
      ids.add(id);
      if (terminated)
        throw new Error(`${path}.${id}: unreachable after control`);
      const kinds = ['use', 'state', 'if', 'foreach', 'loop', 'control'].filter(
        (k) => Object.hasOwn(step, k),
      );
      if (kinds.length !== 1)
        throw new Error(`${path}.${id}: expected exactly one step type`);
      const kind = kinds[0]!;
      const label = `${path}.${id}`;
      const result = this.compileStep(kind, step, scope, stage, label);
      terminated = kind === 'control';
      scope.available[stage]!.add(id);
      const stageType = scope.types[stage] ?? {
        type: 'object',
        properties: {},
      };
      const properties = object(stageType.properties ?? {});
      properties[id] = { type: 'object', properties: { output: result } };
      scope.types[stage] = { type: 'object', properties };
    }
  }

  private compileStep(
    kind: string,
    step: JsonObject,
    scope: Scope,
    stage: string,
    label: string,
  ): JsonObject {
    switch (kind) {
      case 'use':
        return this.compileUse(step, scope, label);
      case 'state':
        return this.compileState(step, scope, label);
      case 'if':
        return this.compileIf(step, scope, stage, label);
      case 'foreach':
        return this.compileForeach(step, scope, stage, label);
      case 'loop':
        return this.compileLoopStep(step, scope, label);
      default:
        return this.compileControl(step, scope, label);
    }
  }

  private compileUse(
    step: JsonObject,
    scope: Scope,
    label: string,
  ): JsonObject {
    unknownKeys(step, ['id', 'use', 'with'], label);
    const name = string(step.use, label);
    if (name === 'reflection') {
      if (object(this.policy.defaults ?? {}).reflection === undefined)
        throw new Error(
          `${String(this.policy.id)} ${label}: use: reflection requires defaults.reflection.configFile`,
        );
      if (scope.parallel)
        throw new Error(`${label}: parallel foreach cannot call Reflection`);
      if (Object.keys(object(step.with ?? {}, `${label}.with`)).length)
        throw new Error(
          `${label}.with: Reflection does not accept per-call configuration`,
        );
      this.usesReflection = true;
      return object(reflectionResultSchema);
    }
    if (!this.require[name])
      throw new Error(`${label}: undeclared dependency ${name}`);
    validateTemplate(step.with ?? {}, scope, label);
    return typeof this.require[name]!.output_schema === 'object'
      ? object(this.require[name]!.output_schema)
      : {};
  }

  private compileState(
    step: JsonObject,
    scope: Scope,
    label: string,
  ): JsonObject {
    unknownKeys(step, ['id', 'state'], label);
    if (scope.parallel)
      throw new Error(`${label}: parallel foreach cannot write shared state`);
    const patch = object(step.state, label);
    validateTemplate(patch, scope, label);
    for (const [key, entry] of Object.entries(patch)) {
      const paths = expressions(entry).flatMap((expression) =>
        expressionPaths(
          compileExpression(expression, Object.keys(scope.types)),
        ),
      );
      if (
        paths.some(
          (path) =>
            path[0] === 'state' &&
            (path.length === 1 ||
              ((Array.isArray(entry) ||
                (entry !== null && typeof entry === 'object')) &&
                path.length === 2 &&
                path[1] === key)),
        )
      )
        throw new Error(`${label}: unbounded recursive state shape for ${key}`);
      if (!safeIdentifier.test(key))
        throw new Error(`${label}: unsafe state key`);
      this.states[key] = mergeSchemas(
        this.states[key],
        inferSchema(entry, scope.types),
      );
    }
    for (const key of Object.keys(patch)) scope.initialized.add(key);
    return {
      type: 'object',
      properties: Object.fromEntries(
        Object.keys(patch).map((k) => [k, this.states[k]!]),
      ),
    };
  }

  private compileIf(
    step: JsonObject,
    scope: Scope,
    stage: string,
    label: string,
  ): JsonObject {
    unknownKeys(step, ['id', 'if', 'then', 'else'], label);
    validateTemplate(step.if!, scope, label);
    if (step.then === undefined) throw new Error(`${label}.then is required`);
    const outcomes: Scope[] = [];
    const outputs: JsonObject[] = [];
    for (const [branchName, rawBranch] of [
      ['then', step.then],
      ['else', step.else],
    ] as const) {
      const branch = normalizeBranch(rawBranch, label);
      const child = cloneScope(scope);
      this.compileSteps(
        branch.steps ?? [],
        child,
        stage,
        `${label}.${branchName}`,
      );
      if (branch.yield !== undefined)
        validateTemplate(branch.yield, child, label);
      outcomes.push(child);
      outputs.push(
        branch.yield === undefined
          ? { type: 'null' }
          : inferSchema(branch.yield, child.types),
      );
    }
    scope.initialized = new Set(
      [...outcomes[0]!.initialized].filter((k) =>
        outcomes[1]!.initialized.has(k),
      ),
    );
    return mergeSchemas(outputs[0], outputs[1]!);
  }

  private compileForeach(
    step: JsonObject,
    scope: Scope,
    stage: string,
    label: string,
  ): JsonObject {
    unknownKeys(
      step,
      ['id', 'foreach', 'as', 'key', 'concurrency', 'steps', 'yield'],
      label,
    );
    validateTemplate(step.foreach!, scope, label);
    validateTemplate(step.concurrency ?? 1, scope, label);
    const name = string(step.as, `${label}.as`);
    if (
      !safeIdentifier.test(name) ||
      scopeRoots.includes(name) ||
      scope.types[name]
    )
      throw new Error(`${label}.as shadows a root`);
    if (step.key === undefined) throw new Error(`${label}.key required`);
    const child = cloneScope(scope);
    const array = inferSchema(step.foreach!, scope.types);
    child.types[name] = array.items ? object(array.items) : {};
    child.parallel =
      scope.parallel ||
      (step.concurrency !== undefined && step.concurrency !== 1);
    child.loopDepth = 0;
    validateTemplate(step.key, child, label);
    this.compileSteps(step.steps ?? [], child, stage, label);
    if (step.yield !== undefined) validateTemplate(step.yield, child, label);
    return {
      type: 'array',
      items:
        step.yield === undefined
          ? { type: 'null' }
          : inferSchema(step.yield, child.types),
    };
  }

  private compileLoopStep(
    step: JsonObject,
    scope: Scope,
    label: string,
  ): JsonObject {
    unknownKeys(step, ['id', 'loop', 'input'], label);
    if (step.input !== undefined) validateTemplate(step.input, scope, label);
    this.compileLoop(object(step.loop, label), scope, label);
    return {};
  }

  private compileControl(
    step: JsonObject,
    scope: Scope,
    label: string,
  ): JsonObject {
    unknownKeys(step, ['id', 'control', 'reason'], label);
    if (!['break', 'continue', 'fail'].includes(string(step.control)))
      throw new Error(`${label}: unsupported control`);
    if (step.control !== 'fail' && scope.loopDepth === 0)
      throw new Error(
        `${label}: control cannot cross foreach or Policy loop boundary`,
      );
    if (step.control === 'fail') {
      if (step.reason === undefined)
        throw new Error(`${label}: fail reason required`);
      validateTemplate(step.reason, scope, label);
    } else if (step.reason !== undefined)
      throw new Error(`${label}: reason only allowed for fail`);
    return {};
  }

  private compileMainLoop(main: JsonObject, scope: Scope): void {
    // Keep loop validation and stage-output inference in their existing order.
    // A loop may run zero times, so its state writes are not definitely initialized.
    this.compileLoop(main, scope, 'loop');
    const body = cloneScope(scope);
    body.loopDepth = 1;
    body.types.loop = {
      type: 'object',
      properties: { index: { type: 'integer' } },
    };
    this.compileSteps(main.steps ?? [], body, 'loop', 'loop');
    scope.available.loop = body.available.loop;
    scope.types.loop = body.types.loop;
  }
}
