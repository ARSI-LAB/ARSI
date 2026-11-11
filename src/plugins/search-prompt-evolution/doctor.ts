import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFileTree, type DoctorContext } from '../../contracts/index.js';
import { string } from '../../shared/json.js';
import { parseConfig } from '../../shared/schema.js';
import { missingPath } from '../shared/doctor/checks.js';
import { configSchema as gepaSchema, type GepaConfig } from './schema.js';
import { validateModules } from './service.js';

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
