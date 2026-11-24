import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DoctorBinding,
  DoctorContext,
  DoctorRegistry,
  DoctorReport,
  DoctorResult,
} from '../../contracts/index.js';
import {
  errorText,
  redactConfiguration,
  RuntimeCleanupInterruptedError,
} from '../../shared/errors.js';
import type { Runtime } from '../context.js';
import { pathContains, selectedResourceFields } from '../learning/resources.js';
import { captureMemorySeed, memoryFiles } from '../learning/memory.js';
import { Recipe } from '../loaders/recipe.js';
import { withBindingInstance } from '../manager/instances.js';
import type { Registry } from '../registry/index.js';
import { openProbeRuntime } from './probe-runtime.js';
import {
  bindingReferenceRules,
  declaredPathRules,
  runDoctorRules,
} from './rules.js';
import {
  appendBindingResult,
  createFailureReport,
  redactDoctorReport,
} from './report.js';

/** The caller owns the Runtime if diagnosis throws before releasing it. */
export async function runDoctor(
  recipePath: string,
  {
    signal,
    openRuntime,
    releaseRuntime,
  }: {
    signal: AbortSignal;
    openRuntime(): Promise<Runtime>;
    releaseRuntime(): Promise<void>;
  },
): Promise<DoctorReport> {
  let runtime: Runtime;
  try {
    runtime = await openRuntime();
  } catch (error) {
    signal.throwIfAborted();
    return createFailureReport('runtime.registration', error);
  }

  const report = await doctorRecipe(runtime, recipePath, { signal }).catch(
    (error: unknown) => {
      signal.throwIfAborted();
      return createFailureReport('doctor.runtime', error);
    },
  );
  try {
    await releaseRuntime();
  } catch (error) {
    if (signal.aborted)
      throw new RuntimeCleanupInterruptedError(signal.reason, error);
    const cleanupReport = createFailureReport('runtime.cleanup', error);
    report.checks.push(...cleanupReport.checks);
  }
  signal.throwIfAborted();
  return report;
}

/** Internal runner: never runs a Policy or writes to the invoking experiment store. */
export async function doctorRecipe(
  sourceRuntime: Runtime,
  recipePath: string,
  { signal = new AbortController().signal }: { signal?: AbortSignal } = {},
): Promise<DoctorReport> {
  signal.throwIfAborted();
  let recipe: Recipe;
  try {
    recipe = await Recipe.load(resolve(recipePath), sourceRuntime.registry, {
      rootDirectory: sourceRuntime.context.rootDirectory,
      runtimeDirectory: sourceRuntime.manager.directory,
    });
  } catch (error) {
    signal.throwIfAborted();
    return createFailureReport('recipe.validate', error);
  }

  const redact = redactConfiguration({
    recipe: recipe.toJSON(),
    reflection: recipe.reflection?.config ?? {},
    memory: recipe.memory?.config ?? {},
  });
  const report: DoctorReport = {
    recipeId: recipe.id,
    checks: [{ id: 'recipe.validate', status: 'passed' }],
  };
  for (const name of recipe.disabledLearning)
    report.checks.push({
      id: `${name}.status`,
      status: 'unchecked',
      reason: 'Disabled by the Recipe or Policy.',
    });
  if (recipe.reflection) {
    const builtins = ['policies', 'plugins'].map((kind) =>
      fileURLToPath(new URL(`../../${kind}/`, import.meta.url)),
    );
    const protectedTarget = Object.entries(recipe.reflection.targets).some(
      ([name, target]) => {
        const binding = recipe.bindings[name]!;
        return selectedResourceFields(
          binding.definition.configSchema,
          binding.config,
          target.resources,
        ).some(({ reference }) =>
          builtins.some((root) => pathContains(root, reference)),
        );
      },
    );
    report.checks.push({
      id: 'reflection.targets',
      status: 'passed',
      ...(protectedTarget
        ? {
            details: {
              note: 'Revisions activate in this experiment. Export built-in resources with arsi reflection apply <id> --to <directory>.',
            },
          }
        : {}),
    });
  }
  await checkBindings(sourceRuntime, recipe, report, signal);
  signal.throwIfAborted();
  return redactDoctorReport(report, redact);
}

async function checkBindings(
  sourceRuntime: Runtime,
  recipe: Recipe,
  report: DoctorReport,
  signal: AbortSignal,
): Promise<void> {
  const bindings = getDoctorBindings(recipe, sourceRuntime.registry);
  const probeRuntime = await openProbeRuntime(sourceRuntime, signal);
  try {
    for (const [bindingIndex, binding] of bindings.entries()) {
      signal.throwIfAborted();
      const bindingContext = await probeRuntime.createBindingContext(
        bindingIndex,
        binding.name,
      );
      await checkBinding(
        {
          binding,
          recipe,
          registry: sourceRuntime.registry,
          runtime: bindingContext,
          directory: bindingContext.directory,
          signal,
        },
        report,
      );
    }
  } finally {
    for (const { id, error } of await probeRuntime.dispose())
      report.checks.push({
        id,
        status: 'failed',
        reason: errorText(error),
      });
  }
}

function getDoctorBindings(
  recipe: Recipe,
  registry: DoctorRegistry,
): DoctorBinding[] {
  const bindings: DoctorBinding[] = [
    recipe.application,
    ...Object.values(recipe.bindings),
  ];
  for (const name of ['memory', 'reflection'] as const) {
    const module = recipe[name];
    if (module)
      bindings.push({
        name,
        pluginId: module.plugin,
        definition: registry.get(module.plugin),
        config: module.config,
      });
  }
  return bindings;
}

async function checkBinding(
  context: DoctorContext & { registry: Registry; recipe: Recipe },
  report: DoctorReport,
): Promise<void> {
  const { binding, signal } = context;
  const rules = [
    ...declaredPathRules(binding),
    ...bindingReferenceRules(context),
  ];
  const seed = context.recipe.memory?.seed;
  if (binding.name === 'memory' && seed)
    rules.push({
      id: 'directory',
      reason: 'Correct the files in the configured Memory seed directory.',
      check: async () => {
        const { artifacts } = context.runtime;
        const ref = await captureMemorySeed(artifacts, seed.directory);
        memoryFiles(await artifacts.readJson(ref));
        return true;
      },
    });
  const prerequisites = await runDoctorRules(rules, signal);
  appendBindingResult(report, binding, prerequisites);
  if (prerequisites.checks.some((check) => check.status === 'failed')) {
    appendBindingResult(report, binding, {
      checks: [
        {
          id: 'plugin',
          status: 'unchecked',
          reason:
            'Plugin diagnostics were not executed because a declared prerequisite failed. Fix it and rerun doctor.',
        },
      ],
    });
    return;
  }

  try {
    const bindingResult = await diagnoseBinding(context.registry, context);
    signal.throwIfAborted();
    appendBindingResult(report, binding, bindingResult);
  } catch (error) {
    signal.throwIfAborted();
    appendBindingResult(report, binding, {
      checks: [
        {
          id: 'script',
          status: 'failed',
          reason: `${errorText(error)} Plugin availability is unknown.`,
        },
      ],
    });
  }
}

export async function diagnoseBinding(
  registry: Registry,
  context: DoctorContext,
): Promise<DoctorResult> {
  const { binding, signal, directory } = context;
  try {
    const result = await withBindingInstance(
      registry,
      { plugin: binding.pluginId, config: binding.config },
      context.runtime.extend({ bindingId: binding.name, signal, directory }),
      'rsi/doctor',
      async (target, event, runtime) => {
        const rules = await target.serial(target, event, {
          ...context,
          runtime,
        });
        if (!rules) throw new Error('Doctor returned no check definitions.');
        return runDoctorRules(rules, signal);
      },
    );
    return (
      result ?? {
        checks: [
          {
            id: 'plugin',
            status: 'unchecked',
            reason: `Binding ${binding.name}, implementation ${binding.pluginId}, has no doctor capability.`,
          },
        ],
      }
    );
  } catch (error) {
    signal.throwIfAborted();
    return {
      checks: [{ id: 'script', status: 'failed', reason: errorText(error) }],
    };
  }
}
