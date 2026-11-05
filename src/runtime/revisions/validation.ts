import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Binding,
  JsonObject,
  JsonSchema,
  OperationDefinition,
  PluginContract,
} from '../../contracts/index.js';
import {
  digest,
  object,
  string,
  strings,
  unknownKeys,
} from '../../shared/json.js';
import { validate } from '../../shared/schema.js';
import { readYaml, resolveConfig } from '../loaders/index.js';
import { safeId } from '../storage/index.js';
import {
  count,
  pointerValue,
  resourceFields,
  selectedResourceFields,
  validateEditableDestinations,
} from './resources.js';

export interface ReflectionConfig {
  path: string;
  digest: string;
  evidence: string[];
  targets: Record<string, { resources: string[] }>;
  goal: string;
  implementation: { contract: string; ref: string; config: JsonObject };
  budget: { modelCalls?: number; elapsedWallMs?: number };
}

function uniqueNames(value: unknown, label: string): string[] {
  const names = strings(value, label);
  if (!names.length) throw new Error(`${label}: must not be empty`);
  if (names.some((name) => !name.trim()))
    throw new Error(`${label}: names must not be empty`);
  if (new Set(names).size !== names.length)
    throw new Error(`${label}: duplicate name`);
  return names;
}

async function validatePaths(
  schema: JsonSchema,
  config: JsonObject,
  label: string,
): Promise<void> {
  for (const field of resourceFields(schema, config)) {
    const path = string(pointerValue(config, field.pointer));
    const info = await lstat(path).catch((error: unknown) => {
      throw new Error(
        `${label}${field.pointer}: cannot read resource ${path}`,
        {
          cause: error,
        },
      );
    });
    if (
      info.isSymbolicLink() ||
      !(field.kind === 'file' ? info.isFile() : info.isDirectory())
    )
      throw new Error(
        `${label}${field.pointer}: expected a regular ${field.kind} resource`,
      );
  }
}

/** Validate and assemble the selected module before application or model side effects. */
export async function validateReflection(
  path: string,
  bindings: Record<string, Binding>,
  getDefinition: (id: string) => OperationDefinition,
  getContract: (id: string) => PluginContract,
): Promise<ReflectionConfig> {
  const absolute = resolve(path);
  try {
    const definition = await readYaml(absolute);
    if (Object.hasOwn(definition, 'rules'))
      throw new Error(
        'rules: migrate legacy Reflection rules to evidence, targets, goal and implementation; add an explicit type: reflection step in the Policy',
      );
    unknownKeys(
      definition,
      ['evidence', 'targets', 'goal', 'implementation', 'budget'],
      'reflection',
    );
    const evidence = uniqueNames(definition.evidence, 'evidence');
    for (const name of evidence)
      if (!bindings[name]) throw new Error(`evidence: unknown binding ${name}`);
    const targets: ReflectionConfig['targets'] = {};
    for (const [name, raw] of Object.entries(
      object(definition.targets, 'targets'),
    )) {
      safeId(name);
      const target = object(raw, `targets.${name}`);
      unknownKeys(target, ['resources'], `targets.${name}`);
      const resources = uniqueNames(
        target.resources,
        `targets.${name}.resources`,
      );
      const binding = bindings[name];
      if (!binding) throw new Error(`targets.${name}: unknown binding`);
      const plugin = getDefinition(binding.plugin);
      selectedResourceFields(plugin.configSchema, binding.config, resources);
      await validatePaths(
        plugin.configSchema,
        binding.config,
        `targets.${name}`,
      );
      targets[name] = { resources };
    }
    if (!Object.keys(targets).length)
      throw new Error('targets: must not be empty');
    await validateEditableDestinations(
      Object.entries(targets).flatMap(([binding, target]) =>
        selectedResourceFields(
          getDefinition(bindings[binding]!.plugin).configSchema,
          bindings[binding]!.config,
          target.resources,
        ).map((field) => ({
          binding,
          pointer: field.pointer,
          kind: field.kind,
          path: string(pointerValue(bindings[binding]!.config, field.pointer)),
        })),
      ),
    );
    const goalFile = resolve(
      dirname(absolute),
      string(definition.goal, 'goal'),
    );
    if (!string(definition.goal, 'goal').trim())
      throw new Error('goal: path must not be empty');
    const goal = await readFile(goalFile)
      .then((bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      .catch((error: unknown) => {
        throw new Error(`goal: cannot read UTF-8 goal file ${goalFile}`, {
          cause: error,
        });
      });
    if (!goal.trim()) throw new Error(`goal: file is empty ${goalFile}`);
    const rawBudget = object(definition.budget ?? {}, 'budget');
    unknownKeys(rawBudget, ['modelCalls', 'timeoutSeconds'], 'budget');
    const budget: ReflectionConfig['budget'] = {};
    if (rawBudget.modelCalls !== undefined)
      budget.modelCalls = count(rawBudget.modelCalls, 'budget.modelCalls');
    if (rawBudget.timeoutSeconds !== undefined) {
      const seconds = count(rawBudget.timeoutSeconds, 'budget.timeoutSeconds');
      const elapsedWallMs = seconds * 1000;
      if (
        seconds <= 0 ||
        !Number.isSafeInteger(elapsedWallMs) ||
        elapsedWallMs > 2147483647
      )
        throw new Error(
          'budget.timeoutSeconds: must be positive and within the timer limit',
        );
      budget.elapsedWallMs = elapsedWallMs;
    }
    const implementation = object(definition.implementation, 'implementation');
    unknownKeys(
      implementation,
      ['contract', 'ref', 'config'],
      'implementation',
    );
    const contract = string(implementation.contract, 'implementation.contract');
    if (contract !== 'contract.reflection')
      throw new Error('implementation.contract: must be contract.reflection');
    let required: PluginContract;
    try {
      required = getContract(contract);
    } catch (error) {
      throw new Error(
        'implementation.contract: contract.reflection is not registered',
        { cause: error },
      );
    }
    const ref = string(implementation.ref, 'implementation.ref');
    let plugin: OperationDefinition;
    try {
      plugin = getDefinition(ref);
    } catch (error) {
      throw new Error(`implementation.ref: unknown implementation ${ref}`, {
        cause: error,
      });
    }
    if (digest(required) !== digest(plugin.contract))
      throw new Error(
        `implementation.ref: ${ref} does not implement ${contract}`,
      );
    const config = structuredClone(
      object(implementation.config ?? {}, 'implementation.config'),
    );
    if (ref === 'reflection.agent') {
      for (const field of ['maxContextBytes', 'maxModelCalls'])
        if (Object.hasOwn(config, field))
          throw new Error(
            `implementation.config.${field}: removed user field${field === 'maxModelCalls' ? '; use budget.modelCalls' : '; context handling is internal'}`,
          );
      const agentRef = string(
        config.agentRef,
        'implementation.config.agentRef',
      );
      const agent = bindings[agentRef];
      if (!agent)
        throw new Error(
          `implementation.config.agentRef: unknown binding ${agentRef}`,
        );
      if (getDefinition(agent.plugin).contract.id !== 'contract.agent')
        throw new Error(
          `implementation.config.agentRef: ${agentRef} must implement contract.agent`,
        );
      if (config.prompt === undefined)
        config.prompt = fileURLToPath(
          new URL('../../plugins/reflection-agent/prompt.md', import.meta.url),
        );
      // Zero is rejected by the module before starting this model-backed generator.
      if (budget.modelCalls !== undefined)
        config.maxModelCalls = Math.max(1, budget.modelCalls);
    }
    validate(plugin.configSchema, config, 'implementation.config');
    const resolvedConfig = resolveConfig(
      config,
      dirname(absolute),
      plugin.configSchema,
    );
    await validatePaths(
      plugin.configSchema,
      resolvedConfig,
      'implementation.config',
    );
    return {
      path: absolute,
      digest: digest({
        path: absolute,
        definition,
        goalFile,
        goalDigest: digest(goal),
      }),
      evidence,
      targets,
      goal,
      implementation: { contract, ref, config: resolvedConfig },
      budget,
    };
  } catch (error) {
    throw new Error(
      `${absolute}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
