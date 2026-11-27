import { dirname, resolve } from 'node:path';
import type { JsonObject } from '../../contracts/json.js';
import { recipeDeclarationSchema } from '../../contracts/recipe.js';
import { applicationContract } from '../../contracts/plugin-types/application.js';
import { object, string, freezeSnapshot } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { Policy } from '../policy/index.js';
import { validateTemplate } from '../compiler/scope.js';
import type { Registry } from '../registry/index.js';
import {
  validateRuntimeEvolution,
  evolutionAgentBinding,
  type MemoryConfig,
  type ReflectionConfig,
} from '../evolution/validation.js';
import type { RuntimeEvolutionKind } from '../../contracts/runtime-evolution.js';
import { Binding } from './binding.js';
import { resolveConfig } from './config.js';
import { readYaml } from './yaml.js';

export interface RecipeLoadOptions {
  sourcePath?: string;
  lockedEvolution?: boolean;
  rootDirectory?: string;
  runtimeDirectory?: string;
  /** A locked Policy definition supplied by Runtime during recovery. */
  policy?: Policy;
  /** Supplied by Runtime when loading immutable experiment definitions. */
  memory?: MemoryConfig;
  reflection?: ReflectionConfig;
}

function parseBudget(value: unknown): Record<string, number> {
  const budget: Record<string, number> = {};
  for (const [key, limit] of Object.entries(
    object(value ?? {}, 'recipe.budget'),
  )) {
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0)
      throw new Error(
        `recipe.budget.${key}: expected a finite nonnegative number`,
      );
    if (
      [
        'operations',
        'evaluationRuns',
        'modelCalls',
        'elapsedWallMs',
        'cleanupReserveMs',
      ].includes(key)
    ) {
      if (!Number.isSafeInteger(limit))
        throw new Error(
          `recipe.budget.${key}: expected a nonnegative safe integer`,
        );
      if (key.endsWith('Ms') && (limit <= 0 || limit > 2147483647))
        throw new Error(
          `recipe.budget.${key}: expected a positive integer within the timer limit`,
        );
    }
    budget[key] = limit;
  }
  return budget;
}

/** An assembled definition. Loading does not create an Application or plugin instance. */
export class Recipe {
  readonly schemaVersion = 'rsi.recipe/v1';
  readonly id: string;
  readonly description: string | undefined;
  readonly sourcePath: string;
  readonly application: Binding;
  readonly policy: Policy;
  readonly policyConfig: JsonObject;
  readonly policyInput: JsonObject;
  readonly bindings: Readonly<Record<string, Binding>>;
  readonly budget: Readonly<Record<string, number>>;
  readonly memory: MemoryConfig | undefined;
  readonly reflection: ReflectionConfig | undefined;
  readonly disabledEvolution: readonly RuntimeEvolutionKind[];

  private readonly evolutionDeclarations: JsonObject;

  private constructor(options: {
    evolutionDeclarations: JsonObject;
    id: string;
    description?: string;
    sourcePath: string;
    application: Binding;
    policy: Policy;
    policyConfig: JsonObject;
    policyInput: JsonObject;
    bindings: Record<string, Binding>;
    budget: Record<string, number>;
    memory?: MemoryConfig;
    reflection?: ReflectionConfig;
    disabledEvolution: RuntimeEvolutionKind[];
  }) {
    this.evolutionDeclarations = freezeSnapshot(options.evolutionDeclarations);
    this.id = options.id;
    this.description = options.description;
    this.sourcePath = options.sourcePath;
    this.application = options.application;
    this.policy = options.policy;
    this.policyConfig = freezeSnapshot(options.policyConfig);
    this.policyInput = freezeSnapshot(options.policyInput);
    this.bindings = Object.freeze(options.bindings);
    this.budget = Object.freeze(options.budget);
    this.disabledEvolution = Object.freeze(options.disabledEvolution);
    this.memory =
      options.memory && freezeSnapshot(structuredClone(options.memory));
    this.reflection =
      options.reflection === undefined
        ? undefined
        : freezeSnapshot(structuredClone(options.reflection));
    Object.freeze(this);
  }

  static async load(
    path: string,
    registry: Registry,
    options: RecipeLoadOptions = {},
  ): Promise<Recipe> {
    return Recipe.fromJSON(await readYaml(path), registry, {
      ...options,
      sourcePath: resolve(path),
    });
  }

  static async fromJSON(
    value: unknown,
    registry: Registry,
    options: RecipeLoadOptions = {},
  ): Promise<Recipe> {
    const data = object(structuredClone(value), 'recipe');
    validate(recipeDeclarationSchema, data, 'recipe');
    const sourcePath = resolve(options.sourcePath ?? 'recipe.yaml');
    const directory = dirname(sourcePath);
    const selectedPolicy = object(data.policy, 'recipe.policy');
    const policyId = string(selectedPolicy.id, 'recipe.policy.id');
    const policy =
      options.policy ??
      (await Policy.load(registry.policy(policyId), registry));
    if (policy.id !== policyId)
      throw new Error(
        `recipe.policy.id: registered ${policyId} selects Policy ${policy.id}`,
      );
    const policyDirectory =
      policy.sourcePath === undefined
        ? policy.directory
        : dirname(policy.sourcePath);
    const policyConfig = structuredClone(
      object(selectedPolicy.config ?? {}, 'recipe.policy.config'),
    );
    validate(policy.configSchema, policyConfig, 'recipe.policy.config');
    const resolvedPolicyConfig = resolveConfig(
      policyConfig,
      directory,
      policy.configSchema,
    );
    const policyInput = structuredClone(
      object(selectedPolicy.input ?? {}, 'recipe.policy.input'),
    );
    validateTemplate(
      policyInput,
      {
        names: ['application', 'config'],
        frames: [],
        parallel: false,
        loopDepth: 0,
      },
      'recipe.policy.input',
    );
    const defaults = object(
      policy.defaults.bindings ?? {},
      'policy.defaults.bindings',
    );
    const provided = object(data.bindings ?? {}, 'recipe.bindings');
    for (const name of [...Object.keys(defaults), ...Object.keys(provided)]) {
      if (!Object.hasOwn(policy.requirements, name))
        throw new Error(
          `Binding ${name} is not declared in Policy ${policy.id} require`,
        );
    }
    const bindings: Record<string, Binding> = {};
    for (const [name, required] of Object.entries(policy.requirements)) {
      bindings[name] = Binding.resolve({
        name,
        required,
        registry,
        ...(Object.hasOwn(defaults, name)
          ? {
              defaults: {
                declaration: defaults[name],
                directory: policyDirectory,
              },
            }
          : {}),
        ...(Object.hasOwn(provided, name)
          ? { override: { declaration: provided[name], directory } }
          : {}),
      });
    }
    const application = Binding.resolve({
      name: 'application',
      required: applicationContract,
      registry,
      override: { declaration: data.application, directory },
    });
    const budget = parseBudget(data.budget);
    const source = {
      policy,
      recipeDirectory: directory,
      bindings,
      registry,
      rootDirectory: options.rootDirectory,
      runtimeDirectory: options.runtimeDirectory,
    };
    const memory =
      options.memory ??
      (options.lockedEvolution
        ? undefined
        : await validateRuntimeEvolution('memory', {
            ...source,
            override: data.memory,
            memoryEnabled: false,
          }));
    const reflection =
      options.reflection ??
      (options.lockedEvolution
        ? undefined
        : await validateRuntimeEvolution('reflection', {
            ...source,
            override: data.reflection,
            memoryEnabled: !!memory,
          }));
    const agentBinding = memory?.agentBinding ?? reflection?.agentBinding;
    if (agentBinding)
      bindings[evolutionAgentBinding] = Binding.resolve({
        name: evolutionAgentBinding,
        required: registry.contract('contract.agent'),
        registry,
        override: { declaration: agentBinding, directory },
      });
    const disabledEvolution: RuntimeEvolutionKind[] = [];
    if (!memory) disabledEvolution.push('memory');
    if (!reflection) disabledEvolution.push('reflection');
    const evolutionDeclarations: JsonObject = {};
    if (data.memory !== undefined) evolutionDeclarations.memory = data.memory;
    if (data.reflection !== undefined)
      evolutionDeclarations.reflection = data.reflection;
    return new Recipe({
      evolutionDeclarations,
      id: string(data.id, 'recipe.id'),
      ...(data.description === undefined
        ? {}
        : { description: String(data.description) }),
      sourcePath,
      application,
      policy,
      policyConfig: resolvedPolicyConfig,
      policyInput,
      bindings,
      budget,
      disabledEvolution,
      ...(memory === undefined ? {} : { memory }),
      ...(reflection === undefined ? {} : { reflection }),
    });
  }

  toJSON(): JsonObject {
    return {
      schemaVersion: this.schemaVersion,
      id: this.id,
      ...(this.description === undefined
        ? {}
        : { description: this.description }),
      application: { ...this.application.toJSON() },
      policy: {
        id: this.policy.id,
        config: structuredClone(this.policyConfig),
        input: structuredClone(this.policyInput),
      },
      bindings: Object.fromEntries(
        Object.entries(this.bindings)
          .filter(([name]) => name !== evolutionAgentBinding)
          .map(([name, binding]) => [name, { ...binding.toJSON() }]),
      ),
      budget: { ...this.budget },
      ...structuredClone(this.evolutionDeclarations),
    };
  }
}
