import type {
  JsonObject,
  JsonValue,
  JsonSchema,
  RuntimeContext,
} from '../../contracts/index.js';
import { object, string, canonical, digest } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { budgetSnapshotSchema } from '../../contracts/runtime/services.js';
import type { CompiledPolicy } from '../compiler/index.js';
import { reflectionResultSchema } from '../revisions/declaration.js';
import { evaluateTemplate } from './expression.js';
export { evaluateTemplate } from './expression.js';
export interface PolicyOptions {
  application: JsonObject;
  context: RuntimeContext;
  invoke(
    binding: string,
    input: JsonValue,
    stablePath: string,
    parallel?: boolean,
  ): Promise<JsonValue>;
  reflect?(
    stablePath: string,
    state: JsonObject,
    parallel: boolean,
  ): Promise<JsonValue>;
  parallel?: boolean;
  checkpoint(snapshot: JsonObject): Promise<void>;
  restore?: JsonObject;
  boundary(iteration: number, state: JsonObject): Promise<void | JsonObject>;
  events?: {
    info: {
      experimentId: string;
      policyScopeId: string;
      checkpointRef: string;
    };
    diagnose(eventName: string, error: unknown): void;
  };
}
class Control extends Error {
  constructor(
    readonly action: 'break' | 'continue' | 'fail',
    message?: string,
  ) {
    super(message ?? action);
  }
}
function asSchema(value: JsonValue | undefined): JsonSchema {
  return typeof value === 'boolean' ? value : object(value ?? {});
}
function integer(
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
function condition(value: JsonValue, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}
function block(value: JsonValue | undefined): JsonObject {
  return value === undefined
    ? { steps: [] }
    : Array.isArray(value)
      ? { steps: value }
      : object(value);
}
/** Interpreter journals deterministic step identities. External calls must also reconcile the supplied stablePath. */
export async function executePolicy(
  policy: CompiledPolicy,
  input: JsonObject,
  config: JsonObject,
  options: PolicyOptions,
): Promise<JsonValue> {
  config = structuredClone(config);
  validate(
    asSchema(
      policy.definition.config_schema ?? {
        type: 'object',
        additionalProperties: false,
      },
    ),
    config,
    'policy.config',
  );
  let environment: JsonObject = {
    application: options.application,
    config,
    input: {},
    state: {},
    init: {},
    loop: {},
    finish: {},
  };
  const mappings = object(policy.definition.input ?? {});
  const missing = Object.fromEntries(
    Object.entries(mappings).filter(([key]) => !Object.hasOwn(input, key)),
  );
  const defaults = object(evaluateTemplate(missing, environment));
  input = structuredClone({ ...defaults, ...input });
  validate(asSchema(policy.definition.input_schema), input, 'policy.input');
  environment.input = input;
  const identity = digest({
    policy: policy.digest,
    input,
    config,
    application: options.application,
  });
  const restored = options.restore ?? {};
  if (restored.identity !== undefined && restored.identity !== identity)
    throw new Error('Policy checkpoint identity differs from locked inputs');
  const journal = object(restored.journal ?? {}),
    boundaries = object(restored.boundaries ?? {}),
    budgetObservations = object(restored.budgetObservations ?? {});
  const eventInfo = options.events && {
    ...options.events.info,
    policyId: string(policy.definition.id),
  };
  const notify = (publish: () => void, eventName: string): void => {
    try {
      publish();
    } catch (error) {
      options.events!.diagnose(eventName, error);
    }
  };
  let queue = Promise.resolve();
  const persist = async (): Promise<void> => {
    const snapshot = structuredClone({
      identity,
      journal,
      boundaries,
      budgetObservations,
    });
    queue = queue.then(() => {
      options.context.signal.throwIfAborted();
      return options.checkpoint(snapshot);
    });
    await queue;
  };
  // Persist observations before evaluating a boundary: a resumed branch must not
  // change because its original budget has since been consumed or time elapsed.
  const observeBudget = async (
    path: string,
    env: JsonObject,
    cached = false,
  ): Promise<void> => {
    const prior = budgetObservations[path];
    if (prior !== undefined) {
      env.budget = structuredClone(prior);
      return;
    }
    if (cached || typeof options.context.readBudget !== 'function') return;
    const snapshot = object(await options.context.readBudget());
    validate(budgetSnapshotSchema, snapshot, 'policy.budget');
    budgetObservations[path] = structuredClone(snapshot);
    env.budget = snapshot;
    await persist();
  };
  const state = object(environment.state);
  const apply = (patch: JsonObject): void => {
    const proposed = { ...state, ...patch };
    validate(policy.stateSchema, proposed, 'policy.state');
    Object.assign(state, patch);
  };
  const applyConfig = (patch: JsonValue | undefined): void => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
    const proposed = { ...config, ...patch };
    validate(
      asSchema(
        policy.definition.config_schema ?? {
          type: 'object',
          additionalProperties: false,
        },
      ),
      proposed,
      'updated policy.config',
    );
    Object.assign(config, patch);
  };
  async function runSteps(
    value: JsonValue,
    env: JsonObject,
    stage: 'init' | 'loop' | 'finish',
    path: string,
    parallel = options.parallel ?? false,
  ): Promise<void> {
    if (!Array.isArray(value)) throw new Error(`${path}.steps must be array`);
    for (const raw of value) {
      options.context.signal.throwIfAborted();
      const step = object(raw),
        id = string(step.id),
        stepPath = `${path}/${id}`,
        stageFrame = object(env[stage]);
      const cached = journal[stepPath];
      await observeBudget(`step:${stepPath}`, env, cached !== undefined);
      let output: JsonValue;
      if (cached !== undefined) {
        const record = object(cached);
        apply(object(record.patch));
        output = record.output!;
      } else {
        const before = structuredClone(state);
        if (step.use !== undefined) {
          const dependency = string(step.use);
          const payload = structuredClone(
            evaluateTemplate(step.with ?? {}, env),
          );
          if (dependency === 'reflection') {
            if (parallel)
              throw new Error(
                `${stepPath}: Reflection requires serial execution`,
              );
            if (!policy.defaults.reflection || !options.reflect)
              throw new Error(`${stepPath}: Reflection module is not declared`);
            if (Object.keys(object(payload, 'reflection input')).length)
              throw new Error(
                `${stepPath}: Reflection does not accept input overrides`,
              );
            output = await options.reflect(
              stepPath,
              structuredClone(state),
              parallel,
            );
            validate(reflectionResultSchema, output, 'reflection.output');
          } else {
            const contract = policy.require[dependency]!;
            validate(
              asSchema(contract.input_schema),
              payload,
              `${dependency}.input`,
            );
            output = await options.invoke(
              dependency,
              payload,
              stepPath,
              parallel,
            );
            validate(
              asSchema(contract.output_schema),
              output,
              `${dependency}.output`,
            );
          }
        } else if (step.state !== undefined) {
          const patch = object(
            structuredClone(evaluateTemplate(step.state, env)),
          );
          apply(patch);
          output = structuredClone(patch);
        } else if (step.if !== undefined) {
          const selected = condition(evaluateTemplate(step.if, env), stepPath)
            ? 'then'
            : 'else';
          const branch = block(step[selected]);
          const child = { ...env, [stage]: { ...object(env[stage]) } };
          await runSteps(
            branch.steps ?? [],
            child,
            stage,
            `${stepPath}/${selected}`,
            parallel,
          );
          output =
            branch.yield === undefined
              ? null
              : evaluateTemplate(branch.yield, child);
        } else if (step.foreach !== undefined) {
          const items = evaluateTemplate(step.foreach, env);
          if (!Array.isArray(items) || items.length > 10000)
            throw new Error(
              `${stepPath}: foreach requires at most 10000 items`,
            );
          const concurrency = integer(
              evaluateTemplate(step.concurrency ?? 1, env),
              `${stepPath}.concurrency`,
              64,
              1,
            ),
            name = string(step.as),
            seen = new Set<string>();
          const entries = items.map((item) => {
            const child = {
              ...env,
              [stage]: { ...object(env[stage]) },
              [name]: item,
            };
            const key = canonical(evaluateTemplate(step.key!, child));
            if (seen.has(key))
              throw new Error(`${stepPath}: duplicate foreach key`);
            seen.add(key);
            return { child, key };
          });
          const results: JsonValue[] = Array(items.length).fill(null);
          let next = 0;
          let stopped = false;
          const worker = async (): Promise<void> => {
            try {
              while (!stopped && next < entries.length) {
                const index = next++,
                  entry = entries[index]!;
                await runSteps(
                  step.steps ?? [],
                  entry.child,
                  stage,
                  `${stepPath}/key-${digest(entry.key)}`,
                  parallel || concurrency > 1,
                );
                results[index] =
                  step.yield === undefined
                    ? null
                    : evaluateTemplate(step.yield, entry.child);
              }
            } catch (error) {
              stopped = true;
              throw error;
            }
          };
          const workers = Array.from(
            { length: Math.min(concurrency, entries.length) },
            worker,
          );
          const settled = await Promise.allSettled(workers);
          const failure = settled.find(
            (result) => result.status === 'rejected',
          );
          if (failure?.status === 'rejected') throw failure.reason;
          output = results;
        } else if (step.loop !== undefined) {
          const nested = object(step.loop),
            child = {
              ...env,
              loop: {
                input: evaluateTemplate(step.input ?? {}, env),
                index: 0,
              },
            };
          await runLoop(nested, child, stepPath, false, parallel);
          output =
            nested.output === undefined
              ? null
              : evaluateTemplate(nested.output, child);
        } else {
          const action = string(step.control);
          if (action === 'fail')
            throw new Control(
              'fail',
              String(evaluateTemplate(step.reason!, env)),
            );
          if (action === 'break' || action === 'continue')
            throw new Control(action);
          throw new Error(`Unknown control ${action}`);
        }
        options.context.signal.throwIfAborted();
        const patch: JsonObject = {};
        for (const [key, current] of Object.entries(state))
          if (
            before[key] === undefined ||
            canonical(current) !== canonical(before[key])
          )
            patch[key] = structuredClone(current);
        journal[stepPath] = { output: structuredClone(output), patch };
        await persist();
        if (eventInfo)
          notify(
            () =>
              options.context.event.emit('rsi/policy-step-completed', {
                ...eventInfo,
                stepPath,
                stage,
              }),
            'rsi/policy-step-completed',
          );
      }
      stageFrame[id] = { output: structuredClone(output) };
    }
  }
  async function runLoop(
    loop: JsonObject,
    env: JsonObject,
    path: string,
    root: boolean,
    parallel = options.parallel ?? false,
  ): Promise<void> {
    await observeBudget(`max:${path}`, env);
    const max = integer(
      evaluateTemplate(loop.maxIterations!, env),
      `${path}.maxIterations`,
      100000,
    );
    const loopInput = object(env.loop).input ?? {};
    for (let index = 0; index < max; index++) {
      options.context.signal.throwIfAborted();
      env.loop = { index, input: loopInput };
      await observeBudget(`while:${path}/${index}`, env);
      if (
        loop.while !== undefined &&
        !condition(evaluateTemplate(loop.while, env), `${path}.while`)
      )
        break;
      let stop = false;
      try {
        await runSteps(
          loop.steps ?? [],
          env,
          'loop',
          `${path}/${index}`,
          parallel,
        );
      } catch (error) {
        if (!(error instanceof Control) || error.action === 'fail') throw error;
        if (error.action === 'break') stop = true;
      }
      if (root) {
        options.context.signal.throwIfAborted();
        const key = String(index);
        const fresh = boundaries[key] === undefined;
        if (fresh) {
          const changed = await options.boundary(index, structuredClone(state));
          options.context.signal.throwIfAborted();
          boundaries[key] = changed ?? null;
          await persist();
        }
        applyConfig(boundaries[key]);
        if (fresh && eventInfo)
          await options.context.event.serial('rsi/policy-boundary-completed', {
            ...eventInfo,
            boundary: 'iteration-completed',
            iteration: index,
          });
        options.context.signal.throwIfAborted();
      }
      if (stop) break;
    }
  }
  if (eventInfo)
    await options.context.event.serial('rsi/policy-started', {
      ...eventInfo,
      resumed: options.restore !== undefined,
    });
  options.context.signal.throwIfAborted();
  await runSteps(
    object(policy.definition.init ?? {}).steps ?? [],
    environment,
    'init',
    'init',
  );
  if (policy.definition.loop !== undefined)
    await runLoop(object(policy.definition.loop), environment, 'loop', true);
  await runSteps(
    object(policy.definition.finish ?? {}).steps ?? [],
    environment,
    'finish',
    'finish',
  );
  if (policy.definition.loop === undefined) {
    options.context.signal.throwIfAborted();
    const fresh = boundaries.completed === undefined;
    if (fresh) {
      const changed = await options.boundary(0, structuredClone(state));
      options.context.signal.throwIfAborted();
      boundaries.completed = changed ?? null;
      await persist();
    }
    applyConfig(boundaries.completed);
    if (fresh && eventInfo)
      await options.context.event.serial('rsi/policy-boundary-completed', {
        ...eventInfo,
        boundary: 'policy-completed',
      });
    options.context.signal.throwIfAborted();
  }
  options.context.signal.throwIfAborted();
  await observeBudget('output', environment);
  const output = evaluateTemplate(policy.definition.output!, environment);
  validate(asSchema(policy.definition.output_schema), output, 'policy.output');
  if (eventInfo)
    notify(
      () => options.context.event.emit('rsi/policy-completed', eventInfo),
      'rsi/policy-completed',
    );
  return output;
}
