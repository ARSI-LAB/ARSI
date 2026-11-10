import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFileTree, type DoctorContext } from '../../contracts/index.js';
import { agentContract } from '../../contracts/plugin-types/agent.js';
import { object, string } from '../../shared/json.js';
import { parseConfig } from '../../shared/schema.js';
import { loadAgentPrompt } from '../../plugins/shared/agent-editing/index.js';
import {
  prepareAgentProject,
  type AgentRole,
} from '../../plugins/shared/agent-editing/project.js';
import type { AgentEditingConfig as ProposerConfig } from '../../plugins/proposer-agent/schema.js';
import { reflectionReviewer } from '../../plugins/reflection-agent/service.js';
import {
  loadOperatorResources,
  readHardwareContext,
} from '../../plugins/proposer-operator/service.js';
import type { OperatorProposerConfig } from '../../plugins/proposer-operator/schema.js';
import { loadOperatorTask } from '../../plugins/shared/operator-task.js';
import { parseOptunaConfig } from '../../plugins/proposer-optuna/schema.js';
import {
  runOptunaWorker,
  validateOptunaWorkerResponse,
  type OptunaWorker,
} from '../../plugins/proposer-optuna/worker.js';
import {
  configSchema as gepaSchema,
  type GepaConfig,
} from '../../plugins/search-prompt-evolution/schema.js';
import { validateModules } from '../../plugins/search-prompt-evolution/service.js';

function resolveAgent(context: DoctorContext, reference: string): void {
  const binding = context.recipe.bindings[reference];
  if (!binding)
    throw new Error(`agentRef: Agent binding ${reference} is not declared`);
  context.registry.assertContract(agentContract, binding.pluginId, reference);
}

function missingPath(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (
    'code' in error &&
    error.code === 'ENOENT' &&
    'path' in error &&
    typeof error.path === 'string'
  )
    return error.path;
  return missingPath(error.cause);
}

export async function checkAgentEditor(context: DoctorContext): Promise<void> {
  const config = parseConfig<ProposerConfig>(
    context.binding.definition.configSchema,
    context.binding.config,
    `${context.binding.name}.config`,
  );
  await context.check('agent-binding', async () => {
    resolveAgent(context, config.agentRef ?? 'agent.default');
  });
  let prompt = '';
  const roles: readonly AgentRole[] =
    context.binding.pluginId === 'reflection.agent'
      ? [reflectionReviewer]
      : (config.subagents ?? []);
  const loaded = await context.check('editing-inputs', async (signal) => {
    try {
      signal.throwIfAborted();
      prompt = await loadAgentPrompt(config);
      for (const directory of config.skills ?? [])
        await readFile(join(directory, 'SKILL.md'), { signal });
      for (const role of roles) await readFile(role.prompt, { signal });
    } catch (error) {
      const path = missingPath(error);
      if (path) {
        const skillIndex = (config.skills ?? []).findIndex(
          (directory) =>
            path === directory || path === join(directory, 'SKILL.md'),
        );
        const roleIndex = roles.findIndex((role) => role.prompt === path);
        const field =
          path === config.prompt
            ? 'config.prompt'
            : skillIndex >= 0
              ? `config.skills.${skillIndex}`
              : roleIndex >= 0
                ? context.binding.pluginId === 'reflection.agent'
                  ? 'bundledReviewer.prompt'
                  : `config.subagents.${roleIndex}.prompt`
                : 'config.guidance';
        context.missing({
          field,
          kind: path === config.guidance ? 'directory' : 'file',
          reference: path,
          checksNotRun: ['prepare-project'],
        });
      }
      throw error;
    }
  });
  if (!loaded) {
    context.unchecked(
      'prepare-project',
      'Editing inputs could not be loaded; project preparation did not run.',
    );
    return;
  }
  await context.check('prepare-project', async (signal) => {
    signal.throwIfAborted();
    await prepareAgentProject(
      context.runtime.extend({ signal }),
      prompt,
      {},
      config.skills ?? [],
      roles,
    );
    signal.throwIfAborted();
  });
}

export async function checkOperationConfiguration(
  context: DoctorContext,
): Promise<void> {
  await context.check('configuration', async (signal) => {
    signal.throwIfAborted();
    const operation = await context.binding.definition.create(
      structuredClone(context.binding.config),
      context.runtime.extend({ signal }),
    );
    try {
      signal.throwIfAborted();
    } finally {
      await operation.dispose();
    }
  });
}

export async function checkOperatorProposer(
  context: DoctorContext,
): Promise<void> {
  const config = parseConfig<OperatorProposerConfig>(
    context.binding.definition.configSchema,
    context.binding.config,
    `${context.binding.name}.config`,
  );
  await context.check('agent-binding', async () => {
    resolveAgent(context, config.agentRef);
  });
  await context.check('operator-task', async (signal) => {
    signal.throwIfAborted();
    try {
      await loadOperatorTask(config.task.directory);
    } catch (error) {
      const path = missingPath(error);
      if (path)
        context.missing({
          field: 'config.task.directory',
          kind: 'file',
          reference: path,
          checksNotRun: [],
        });
      throw error;
    }
  });
  await context.check('operator-resources', async (signal) => {
    signal.throwIfAborted();
    try {
      await loadOperatorResources(config);
    } catch (error) {
      const path = missingPath(error);
      if (path)
        context.missing({
          field: path.startsWith(config.promptsDirectory)
            ? 'config.promptsDirectory'
            : path === config.embedding.retrievalScript
              ? 'config.embedding.retrievalScript'
              : 'config.embedding.resourcesDirectory',
          kind: 'file',
          reference: path,
          checksNotRun: [],
        });
      throw error;
    }
  });
  if (config.hardwareContextFile)
    await context.check('hardware-context', async () => {
      await readHardwareContext(config.hardwareContextFile!);
    });
}

export async function checkOptunaDependencies(
  context: DoctorContext,
  worker: OptunaWorker = runOptunaWorker,
): Promise<void> {
  const config = parseOptunaConfig(context.binding.config);
  await context.check('python-dependencies', async (signal) => {
    const result = await worker(
      config,
      {
        action: 'check',
        sampler: object(config.sampler),
        constraintHandling: config.constraintHandling,
        searchSpace: config.searchSpace,
        history: [],
      },
      signal,
    );
    validateOptunaWorkerResponse(result, 'check');
  });
}

export async function checkPromptEvolutionSearch(
  context: DoctorContext,
): Promise<void> {
  const config = parseConfig<GepaConfig>(
    gepaSchema,
    context.binding.config,
    `${context.binding.name}.config`,
  );
  const valid = await context.check('modules', async () => {
    validateModules(config.modules);
  });
  if (!valid) {
    context.unchecked(
      'baseline-modules',
      'The module configuration is invalid.',
    );
    return;
  }
  const baseline = context.recipe.application.config.baseline;
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    context.unchecked(
      'baseline-modules',
      'The Application does not expose a local baseline directory.',
    );
    return;
  }
  if (typeof baseline.artifactRef === 'string') {
    const artifactRef = baseline.artifactRef;
    await context.check('baseline-modules', async (signal) => {
      signal.throwIfAborted();
      const tree = parseFileTree(
        await context.runtime.artifacts.readJson(artifactRef),
      );
      for (const module of config.modules)
        if (!tree.files.some((file) => file.path === module.path))
          throw new Error(
            `GEPA module is missing from baseline artifact: ${module.path}`,
          );
    });
    return;
  }
  const directory = string(baseline.directory);
  try {
    if (!(await lstat(directory)).isDirectory()) {
      await context.check('baseline-modules', async () => {
        throw new Error(`Expected baseline directory: ${directory}`);
      });
      return;
    }
  } catch (error) {
    if (!missingPath(error)) throw error;
    context.missing({
      field: 'application.config.baseline.directory',
      kind: 'directory',
      reference: directory,
      checksNotRun: ['baseline-modules'],
    });
    context.unchecked(
      'baseline-modules',
      'The baseline directory is unavailable.',
    );
    return;
  }
  await context.check('baseline-modules', async (signal) => {
    for (const module of config.modules) {
      const path = join(directory, module.path);
      try {
        if (!(await lstat(path)).isFile())
          throw new Error(`GEPA module must be a regular file: ${path}`);
        await readFile(path, { signal });
      } catch (error) {
        if (missingPath(error))
          context.missing({
            field: `config.modules.${module.id}.path`,
            kind: 'file',
            reference: path,
            checksNotRun: [],
          });
        throw error;
      }
    }
  });
}
