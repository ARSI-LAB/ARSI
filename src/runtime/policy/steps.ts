import { expressions } from './expression.js';
import type {
  JsonObject,
  JsonValue,
  JsonSchema,
  PluginContract,
} from '../../contracts/index.js';
import {
  canonical,
  digest,
  object,
  string,
  unknownKeys,
} from '../../shared/json.js';

export type StepType =
  | 'invoke'
  | 'state'
  | 'if'
  | 'loop'
  | 'foreach'
  | 'control'
  | 'reflection';
export type StepResult =
  | { kind: 'completed'; output: JsonValue }
  | { kind: 'break' }
  | { kind: 'continue' };
export type Template = JsonValue;
export interface StepBlock {
  readonly steps: readonly Step[];
  readonly output: Template;
}
export interface StepValidationContext {
  readonly label: string;
  readonly requirements: Readonly<Record<string, PluginContract>>;
  readonly stateSchema: JsonSchema;
  readonly parallel: boolean;
  readonly loopDepth: number;
  readonly reflectionDeclared: boolean;
  readonly names: readonly string[];
  validateTemplate(template: Template, locals?: readonly string[]): void;
  validateSteps(
    steps: readonly Step[],
    options: {
      scope: string;
      locals?: readonly string[];
      parallel?: boolean;
      loopDepth?: number;
      output?: Template;
    },
  ): void;
}
export interface StepContext {
  readonly input: JsonObject;
  readonly config: JsonObject;
  readonly application: JsonObject;
  readonly state: JsonObject;
  readonly signal: AbortSignal;
  readonly stepPath: string;
  readonly parallel: boolean;
  evaluate(template: Template, locals?: JsonObject): JsonValue;
  invoke(binding: string, input: JsonValue): Promise<JsonValue>;
  updateState(patch: JsonObject): JsonObject;
  reflect(): Promise<JsonValue>;
  runSteps(
    steps: readonly Step[],
    options: {
      scope: string;
      locals?: JsonObject;
      parallel?: boolean;
      output?: Template;
    },
  ): Promise<StepResult>;
  boundary(iteration: number): Promise<void>;
  /** Freeze a read-only budget observation before a loop decision. */
  observeBudget(key: string): Promise<void>;
}
export interface Step {
  readonly id: string;
  readonly type: StepType;
  validate(context: StepValidationContext): void;
  execute(context: StepContext): Promise<StepResult>;
  toJSON(): JsonObject;
}
export const reservedNames = [
  'budget',
  'application',
  'config',
  'input',
  'state',
  'steps',
  'loop',
  'init',
  'finish',
  '__proto__',
  'prototype',
  'constructor',
];
export const safeIdentifier = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** Definition data is frozen; each evaluation and serialization receives an owned copy. */
export function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function declaration(
  value: JsonObject,
  type: StepType,
  fields: string[],
): string {
  unknownKeys(value, ['id', 'type', ...fields], `${type} step`);
  if (value.type !== type) throw new Error(`step.type: expected ${type}`);
  const id = string(value.id, 'step.id');
  if (
    !safeIdentifier.test(id) ||
    ['__proto__', 'prototype', 'constructor'].includes(id)
  )
    throw new Error(`step.id: unsafe identifier ${id}`);
  return id;
}
function required(value: JsonValue | undefined, label: string): JsonValue {
  if (value === undefined) throw new Error(`${label} is required`);
  return immutable(structuredClone(value));
}
export function boundedInteger(
  value: JsonValue,
  label: string,
  maximum: number,
  minimum = 0,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error(`${label} must be an integer ${minimum}..${maximum}`);
  return value;
}
function boolean(value: JsonValue, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}
function readBlock(value: JsonValue | undefined, label: string): StepBlock {
  if (value === undefined)
    return Object.freeze({ steps: Object.freeze([]), output: null });
  const block = object(value, label);
  unknownKeys(block, ['steps', 'output'], label);
  return Object.freeze({
    steps: parseSteps(block.steps, label),
    output: immutable(structuredClone(block.output ?? null)),
  });
}
function blockJSON(block: StepBlock): JsonObject {
  return {
    steps: block.steps.map((step) => step.toJSON()),
    output: structuredClone(block.output),
  };
}
export class InvokeStep implements Step {
  readonly type = 'invoke';
  readonly id: string;
  readonly bindingName: string;
  readonly inputTemplate: Template;
  constructor(value: JsonObject) {
    this.id = declaration(value, this.type, ['use', 'with']);
    this.bindingName = string(value.use, `${this.id}.use`);
    this.inputTemplate = immutable(
      structuredClone(value.with === undefined ? {} : value.with),
    );
    Object.freeze(this);
  }
  validate(context: StepValidationContext): void {
    if (!Object.hasOwn(context.requirements, this.bindingName))
      throw new Error(
        `${context.label}: undeclared dependency ${this.bindingName}`,
      );
    context.validateTemplate(this.inputTemplate);
  }
  async execute(context: StepContext): Promise<StepResult> {
    return {
      kind: 'completed',
      output: await context.invoke(
        this.bindingName,
        context.evaluate(this.inputTemplate),
      ),
    };
  }
  toJSON(): JsonObject {
    return {
      id: this.id,
      type: this.type,
      use: this.bindingName,
      with: structuredClone(this.inputTemplate),
    };
  }
}
export class StateStep implements Step {
  readonly type = 'state';
  readonly id: string;
  readonly patchTemplate: JsonObject;
  constructor(value: JsonObject) {
    this.id = declaration(value, this.type, ['state']);
    this.patchTemplate = immutable(
      structuredClone(object(value.state, `${this.id}.state`)),
    );
    Object.freeze(this);
  }
  validate(context: StepValidationContext): void {
    if (context.parallel)
      throw new Error(
        `${context.label}: parallel execution cannot write shared state`,
      );
    context.validateTemplate(this.patchTemplate);
    if (
      typeof context.stateSchema === 'object' &&
      context.stateSchema.additionalProperties === false
    ) {
      const properties = object(context.stateSchema.properties ?? {});
      const patterns = Object.keys(
        object(context.stateSchema.patternProperties ?? {}),
      ).map((pattern) => new RegExp(pattern, 'u'));
      for (const name of Object.keys(this.patchTemplate))
        if (
          !Object.hasOwn(properties, name) &&
          !patterns.some((pattern) => pattern.test(name))
        )
          throw new Error(
            `${context.label}: state.${name} is not declared in state_schema`,
          );
    }
  }
  async execute(context: StepContext): Promise<StepResult> {
    return {
      kind: 'completed',
      output: context.updateState(
        object(
          context.evaluate(this.patchTemplate),
          `${context.stepPath}.state`,
        ),
      ),
    };
  }
  toJSON(): JsonObject {
    return {
      id: this.id,
      type: this.type,
      state: structuredClone(this.patchTemplate),
    };
  }
}
export class IfStep implements Step {
  readonly type = 'if';
  readonly id: string;
  readonly condition: Template;
  readonly thenBranch: StepBlock;
  readonly elseBranch: StepBlock;
  constructor(value: JsonObject) {
    this.id = declaration(value, this.type, ['if', 'then', 'else']);
    this.condition = required(value.if, `${this.id}.if`);
    if (value.then === undefined)
      throw new Error(`${this.id}.then is required`);
    this.thenBranch = readBlock(value.then, `${this.id}.then`);
    this.elseBranch = readBlock(value.else, `${this.id}.else`);
    Object.freeze(this);
  }
  validate(context: StepValidationContext): void {
    context.validateTemplate(this.condition);
    context.validateSteps(this.thenBranch.steps, {
      scope: 'then',
      output: this.thenBranch.output,
    });
    context.validateSteps(this.elseBranch.steps, {
      scope: 'else',
      output: this.elseBranch.output,
    });
  }
  async execute(context: StepContext): Promise<StepResult> {
    const selected = boolean(
      context.evaluate(this.condition),
      `${context.stepPath}.if`,
    )
      ? 'then'
      : 'else';
    const block = selected === 'then' ? this.thenBranch : this.elseBranch;
    return context.runSteps(block.steps, {
      scope: selected,
      output: block.output,
    });
  }
  toJSON(): JsonObject {
    return {
      id: this.id,
      type: this.type,
      if: structuredClone(this.condition),
      then: blockJSON(this.thenBranch),
      else: blockJSON(this.elseBranch),
    };
  }
}
export class LoopStep implements Step {
  readonly type = 'loop';
  readonly id: string;
  readonly maxIterations: Template;
  readonly condition: Template;
  readonly steps: readonly Step[];
  readonly output: Template;
  constructor(value: JsonObject) {
    this.id = declaration(value, this.type, [
      'maxIterations',
      'while',
      'steps',
      'output',
    ]);
    this.maxIterations = required(
      value.maxIterations,
      `${this.id}.maxIterations`,
    );
    if (!expressions(this.maxIterations).length)
      boundedInteger(this.maxIterations, `${this.id}.maxIterations`, 100000);
    this.condition = immutable(
      structuredClone(value.while === undefined ? true : value.while),
    );
    this.steps = parseSteps(value.steps, this.id);
    this.output = immutable(structuredClone(value.output ?? null));
    Object.freeze(this);
  }
  validate(context: StepValidationContext): void {
    context.validateTemplate(this.maxIterations);
    context.validateTemplate(this.condition, ['loop']);
    context.validateSteps(this.steps, {
      scope: 'iteration',
      locals: ['loop'],
      loopDepth: context.loopDepth + 1,
    });
    context.validateTemplate(this.output);
  }
  async execute(context: StepContext): Promise<StepResult> {
    await context.observeBudget('max');
    const maximum = boundedInteger(
      context.evaluate(this.maxIterations),
      `${context.stepPath}.maxIterations`,
      100000,
    );
    for (let index = 0; index < maximum; index++) {
      context.signal.throwIfAborted();
      const locals = { loop: { index } };
      await context.observeBudget(`while:${index}`);
      if (
        !boolean(
          context.evaluate(this.condition, locals),
          `${context.stepPath}.while`,
        )
      )
        break;
      const result = await context.runSteps(this.steps, {
        scope: `iteration-${index}`,
        locals,
      });
      await context.boundary(index);
      if (result.kind === 'break') break;
    }
    await context.observeBudget('output');
    return { kind: 'completed', output: context.evaluate(this.output) };
  }
  toJSON(): JsonObject {
    return {
      id: this.id,
      type: this.type,
      maxIterations: structuredClone(this.maxIterations),
      while: structuredClone(this.condition),
      steps: this.steps.map((step) => step.toJSON()),
      output: structuredClone(this.output),
    };
  }
}
export class ForEachStep implements Step {
  readonly type = 'foreach';
  readonly id: string;
  readonly items: Template;
  readonly itemName: string;
  readonly key: Template;
  readonly concurrency: Template;
  readonly steps: readonly Step[];
  readonly output: Template;
  constructor(value: JsonObject) {
    this.id = declaration(value, this.type, [
      'foreach',
      'as',
      'key',
      'concurrency',
      'steps',
      'output',
    ]);
    this.items = required(value.foreach, `${this.id}.foreach`);
    this.itemName = string(value.as, `${this.id}.as`);
    if (
      !safeIdentifier.test(this.itemName) ||
      reservedNames.includes(this.itemName)
    )
      throw new Error(
        `${this.id}.as: reserved or unsafe name ${this.itemName}`,
      );
    this.key = required(value.key, `${this.id}.key`);
    this.concurrency = immutable(
      structuredClone(value.concurrency === undefined ? 1 : value.concurrency),
    );
    if (!expressions(this.concurrency).length)
      boundedInteger(this.concurrency, `${this.id}.concurrency`, 64, 1);
    this.steps = parseSteps(value.steps, this.id);
    this.output = immutable(structuredClone(value.output ?? null));
    Object.freeze(this);
  }
  validate(context: StepValidationContext): void {
    if (context.names.includes(this.itemName))
      throw new Error(
        `${context.label}.as: name ${this.itemName} is already declared`,
      );
    context.validateTemplate(this.items);
    context.validateTemplate(this.concurrency);
    context.validateTemplate(this.key, [this.itemName]);
    context.validateSteps(this.steps, {
      scope: 'item',
      locals: [this.itemName],
      parallel:
        context.parallel ||
        (typeof this.concurrency === 'number' && this.concurrency > 1),
      loopDepth: 0,
      output: this.output,
    });
  }
  async execute(context: StepContext): Promise<StepResult> {
    const items = context.evaluate(this.items);
    if (!Array.isArray(items) || items.length > 10000)
      throw new Error(
        `${context.stepPath}: foreach requires at most 10000 items`,
      );
    const concurrency = boundedInteger(
      context.evaluate(this.concurrency),
      `${context.stepPath}.concurrency`,
      64,
      1,
    );
    const parallel = context.parallel || concurrency > 1;
    if (parallel) assertParallelSafe(this.steps, context.stepPath);
    const seen = new Set<string>();
    const entries = items.map((item) => {
      const locals = { [this.itemName]: item };
      const key = canonical(context.evaluate(this.key, locals));
      if (seen.has(key))
        throw new Error(`${context.stepPath}: duplicate foreach key`);
      seen.add(key);
      return { locals, key };
    });
    const results: JsonValue[] = Array(items.length).fill(null);
    let next = 0;
    let stopped = false;
    const worker = async (): Promise<void> => {
      try {
        while (!stopped && next < entries.length) {
          context.signal.throwIfAborted();
          const index = next++;
          const entry = entries[index]!;
          const result = await context.runSteps(this.steps, {
            scope: `key-${digest(entry.key)}`,
            locals: entry.locals,
            parallel,
            output: this.output,
          });
          if (result.kind !== 'completed')
            throw new Error(
              `${context.stepPath}: control cannot cross foreach boundary`,
            );
          results[index] = result.output;
        }
      } catch (error) {
        stopped = true;
        throw error;
      }
    };
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, entries.length) }, worker),
    );
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return { kind: 'completed', output: results };
  }
  toJSON(): JsonObject {
    return {
      id: this.id,
      type: this.type,
      foreach: structuredClone(this.items),
      as: this.itemName,
      key: structuredClone(this.key),
      concurrency: structuredClone(this.concurrency),
      steps: this.steps.map((step) => step.toJSON()),
      output: structuredClone(this.output),
    };
  }
}
export type ControlAction =
  | { action: 'break' }
  | { action: 'continue' }
  | { action: 'fail'; reason: Template };
export class ControlStep implements Step {
  readonly type = 'control';
  readonly id: string;
  readonly control: ControlAction;
  constructor(value: JsonObject) {
    this.id = declaration(value, this.type, ['control', 'reason']);
    if (value.control === 'fail')
      this.control = Object.freeze({
        action: 'fail',
        reason: required(value.reason, `${this.id}.reason`),
      });
    else if (value.control === 'break' || value.control === 'continue') {
      if (value.reason !== undefined)
        throw new Error(`${this.id}.reason: only fail accepts reason`);
      this.control = Object.freeze({ action: value.control });
    } else
      throw new Error(`${this.id}.control: expected break, continue or fail`);
    Object.freeze(this);
  }
  validate(context: StepValidationContext): void {
    if (this.control.action === 'fail')
      context.validateTemplate(this.control.reason);
    else if (!context.loopDepth)
      throw new Error(
        `${context.label}: ${this.control.action} requires a loop and cannot cross foreach boundary`,
      );
  }
  async execute(context: StepContext): Promise<StepResult> {
    if (this.control.action !== 'fail') return { kind: this.control.action };
    const reason = context.evaluate(this.control.reason);
    if (typeof reason !== 'string')
      throw new Error(`${context.stepPath}.reason must be string`);
    throw new Error(reason);
  }
  toJSON(): JsonObject {
    return {
      id: this.id,
      type: this.type,
      control: this.control.action,
      ...(this.control.action === 'fail'
        ? { reason: structuredClone(this.control.reason) }
        : {}),
    };
  }
}
export class ReflectionStep implements Step {
  readonly type = 'reflection';
  readonly id: string;
  constructor(value: JsonObject) {
    this.id = declaration(value, this.type, []);
    Object.freeze(this);
  }
  validate(context: StepValidationContext): void {
    if (!context.reflectionDeclared)
      throw new Error(
        `${context.label}: Reflection requires defaults.reflection.configFile`,
      );
    if (context.parallel)
      throw new Error(
        `${context.label}: parallel execution cannot call Reflection`,
      );
  }
  async execute(context: StepContext): Promise<StepResult> {
    return { kind: 'completed', output: await context.reflect() };
  }
  toJSON(): JsonObject {
    return { id: this.id, type: this.type };
  }
}
export function parseSteps(
  value: JsonValue | undefined,
  label: string,
): readonly Step[] {
  if (!Array.isArray(value)) throw new Error(`${label}.steps must be an array`);
  const steps = value.map((raw) => {
    const step = object(raw, `${label}.step`);
    switch (step.type) {
      case 'invoke':
        return new InvokeStep(step);
      case 'state':
        return new StateStep(step);
      case 'if':
        return new IfStep(step);
      case 'loop':
        return new LoopStep(step);
      case 'foreach':
        return new ForEachStep(step);
      case 'control':
        return new ControlStep(step);
      case 'reflection':
        return new ReflectionStep(step);
      default:
        throw new Error(
          `${label}.${String(step.id)}.type: unknown step type ${String(step.type)}`,
        );
    }
  });
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id))
      throw new Error(`${label}: duplicate step id ${step.id}`);
    ids.add(step.id);
  }
  return Object.freeze(steps);
}
export function assertParallelSafe(
  steps: readonly Step[],
  label: string,
): void {
  for (const step of steps) {
    if (step instanceof StateStep || step instanceof ReflectionStep)
      throw new Error(
        `${label}/${step.id}: parallel execution cannot ${step.type === 'state' ? 'write shared state' : 'call Reflection'}`,
      );
    if (step instanceof IfStep) {
      assertParallelSafe(step.thenBranch.steps, label);
      assertParallelSafe(step.elseBranch.steps, label);
    }
    if (step instanceof LoopStep || step instanceof ForEachStep)
      assertParallelSafe(step.steps, label);
  }
}
