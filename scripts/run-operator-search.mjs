#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument, stringify } from 'yaml';
import {
  inspectOperatorInputs,
  validateOperatorSearchBudgets,
  operatorBuildIdentity,
  prepareOperatorInputs,
  summarizeOperatorExperiment,
} from './operator-inputs.mjs';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const usage =
  'Usage: node scripts/run-operator-search.mjs --python <sdk-python> --device <id> --embedding-python <python> --model-directory <weights> --embedding-identity <json> --id <unique-id> [--calibration <campaign-id>] [--recipe <yaml>] [--min-relative-improvement <ratio>] [--max-rounds <1..10>] [--msprof-bin <path>] [--resume]\n       Add --validate for configuration/model-file validation only; no calibration, model calls or device execution.\n';
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value;
}
async function readRecipe(path) {
  const document = parseDocument(await readFile(path, 'utf8'), {
    uniqueKeys: true,
  });
  if (document.errors.length) throw document.errors[0];
  return record(document.toJS({ maxAliasCount: 0 }), 'Recipe');
}
function localRecipe(recipe, directory, parameters) {
  const result = structuredClone(recipe);
  if (parameters.maxRounds !== undefined)
    result.policy.config.maxRounds = parameters.maxRounds;
  const application = record(
    record(result.application, 'application').config,
    'application.config',
  );
  application.baseline.directory = resolve(
    directory,
    application.baseline.directory,
  );
  application.target.schema = resolve(directory, application.target.schema);
  const bindings = record(result.bindings, 'bindings');
  for (const name of ['evaluator', 'proposer'])
    bindings[name].config.task.directory = resolve(
      directory,
      bindings[name].config.task.directory,
    );
  if (bindings.proposer.config.hardwareContextFile)
    bindings.proposer.config.hardwareContextFile = resolve(
      directory,
      bindings.proposer.config.hardwareContextFile,
    );
  Object.assign(bindings.evaluator.config.sdk, {
    python: parameters.python,
    device: parameters.device,
  });
  if (parameters.msprofBin !== undefined)
    bindings.evaluator.config.sdk.profiling = {
      ...bindings.evaluator.config.sdk.profiling,
      msprofBin: parameters.msprofBin,
    };
  Object.assign(bindings.proposer.config.embedding, parameters.embedding, {
    device: 'cpu',
  });
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean' },
      validate: { type: 'boolean' },
      resume: { type: 'boolean' },
      id: { type: 'string' },
      recipe: { type: 'string' },
      calibration: { type: 'string' },
      python: { type: 'string' },
      device: { type: 'string' },
      'msprof-bin': { type: 'string' },
      'embedding-python': { type: 'string' },
      'model-directory': { type: 'string' },
      'embedding-identity': { type: 'string' },
      'min-relative-improvement': { type: 'string' },
      'max-rounds': { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(usage);
    return 0;
  }
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 22 || (minor === 22 && patch < 1))
    throw new Error('Evaluator requires Node >=24.22.1 <25');
  if (
    !values.python ||
    !/^\d+$/.test(values.device ?? '') ||
    !values['embedding-python'] ||
    !values['model-directory'] ||
    !values['embedding-identity']
  )
    throw new Error(
      'Supply explicit SDK Python/device and embedding Python/model-directory/embedding-identity',
    );
  if (values.validate && values.resume)
    throw new Error('--validate cannot resume an experiment');
  if (
    !values.validate &&
    (!values.id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(values.id))
  )
    throw new Error('Formal search requires a valid --id');
  const rootDirectory = process.cwd(),
    controller = new AbortController();
  const abort = () => controller.abort(new Error('Interrupted'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const runtimeDirectory = join(packageDirectory, 'dist');
  const load = (relative) =>
    import(pathToFileURL(join(runtimeDirectory, relative)).href);
  let runtime, lease, prepared, failure, summary;
  try {
    const [
      { createRuntime, validateRecipe },
      { readEmbeddingIdentity },
      { loadOperatorTask },
      { verifySearchCalibration, finalTimingStable, assessSearchConfidence },
      { acquireDeviceSession },
      { inspectNpuHost },
    ] = await Promise.all([
      load('src/index.js'),
      load('src/plugins/proposer-operator/retrieval.js'),
      load('src/plugins/evaluator-operatorbench/task.js'),
      load('src/entries/cli/operator-experiments/search.js'),
      load('src/entries/cli/operator-experiments/device-session.js'),
      load('src/entries/cli/operator-experiments/preflight.js'),
    ]);
    const maxRounds =
      values['max-rounds'] === undefined
        ? undefined
        : Number(values['max-rounds']);
    if (
      maxRounds !== undefined &&
      (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 10)
    )
      throw new Error('max-rounds must be an integer 1..10');
    const parameters = {
      maxRounds,
      python: values.python,
      device: Number(values.device),
      ...(values['msprof-bin'] === undefined
        ? {}
        : { msprofBin: resolve(values['msprof-bin']) }),
      embedding: {
        python: values['embedding-python'],
        modelDirectory: resolve(values['model-directory']),
        identityFile: resolve(values['embedding-identity']),
      },
    };
    const model = await readEmbeddingIdentity(
      parameters.embedding,
      controller.signal,
    );
    let recipePath = resolve(
      values.recipe ??
        join(
          packageDirectory,
          'examples/artifacts/kernel/qianchuan-top3/recipe.search.yaml',
        ),
    );
    if (values.resume)
      recipePath = (
        await inspectOperatorInputs(
          join(
            rootDirectory,
            '.rsi/operator-search',
            values.id,
            'manifest.json',
          ),
        )
      ).recipePath;
    const recipe = await readRecipe(recipePath);
    validateOperatorSearchBudgets(recipe);
    if (recipe.policy?.id !== 'policy.operator-search')
      throw new Error('Search requires policy.operator-search');
    const binding = record(recipe.bindings, 'bindings'),
      evaluator = record(binding.evaluator?.config, 'evaluator.config');
    if (evaluator.sdk?.profiling?.enabled !== false)
      throw new Error('Search requires profiling false');
    runtime = await createRuntime({ rootDirectory });
    if (values.validate) {
      const directory = await mkdtemp(join(tmpdir(), 'rsi-search-validate-'));
      try {
        const path = join(directory, 'recipe.yaml');
        await writeFile(
          path,
          stringify(localRecipe(recipe, dirname(recipePath), parameters)),
        );
        const validated = await validateRecipe(runtime, path);
        process.stdout.write(
          JSON.stringify(
            {
              kind: 'configuration-validation',
              recipe: validated,
              embeddingDigest: model.digest,
              performanceQualified: false,
              deviceExecution: false,
            },
            null,
            2,
          ) + '\n',
        );
        return 0;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    // The same lease as calibration/preflight covers host observation, admission and all SDK work.
    lease = await acquireDeviceSession({
      rootDirectory,
      owner: `search:${values.id}`,
      reader: runtime.manager,
    });
    const host = await inspectNpuHost({
      rootDirectory,
      python: parameters.python,
      device: parameters.device,
      signal: controller.signal,
    });
    if (!host.ready)
      throw new Error(`Search host is not ready: ${host.issues.join('; ')}`);
    const task = await loadOperatorTask(
      resolve(dirname(recipePath), evaluator.task.directory),
    );
    const caseIds = recipe.policy.config?.caseIds;
    if (
      !Array.isArray(caseIds) ||
      caseIds.length !== 1 ||
      typeof caseIds[0] !== 'string'
    )
      throw new Error('Search requires exactly one explicit case ID');
    const protocol = {
      ...evaluator.protocol,
    };
    const expected = {
      caseId: caseIds[0],
      taskDigest: task.taskDigest,
      sourceDigest: createHash('sha256')
        .update(
          await readFile(
            resolve(
              dirname(recipePath),
              recipe.application.config.baseline.directory,
              'input.py',
            ),
          ),
        )
        .digest('hex'),
      protocol,
    };
    const minRelativeImprovement =
      values['min-relative-improvement'] === undefined
        ? binding.selector.config.minRelativeImprovement
        : Number(values['min-relative-improvement']);
    if (
      !Number.isFinite(minRelativeImprovement) ||
      minRelativeImprovement < 0 ||
      minRelativeImprovement >= 1
    )
      throw new Error('min-relative-improvement must be in [0, 1)');
    const calibration = await verifySearchCalibration({
      rootDirectory,
      campaignId: values.calibration,
      manager: runtime.manager,
      hostIdentity: host.identity,
      buildDigest: (await operatorBuildIdentity()).digest,
      expected,
      python: parameters.python,
      device: parameters.device,
      inspectSnapshot: inspectOperatorInputs,
    });
    prepared = await prepareOperatorInputs(
      recipePath,
      rootDirectory,
      values.id,
      {
        kind: 'search',
        maxRounds,
        resume: values.resume,
        entryScriptPath: fileURLToPath(import.meta.url),
        sdk: {
          python: parameters.python,
          device: parameters.device,
          profiling: false,
          ...(parameters.msprofBin === undefined
            ? {}
            : { msprofBin: parameters.msprofBin }),
          protocol: { warmup: protocol.warmup, repeat: protocol.repeat },
        },
        embedding: parameters.embedding,
        calibration,
        minRelativeImprovement,
      },
    );
    await runtime.dispose();
    runtime = undefined;
    const frozen = await import(
      pathToFileURL(join(prepared.runtimeDirectory, 'src/index.js')).href
    );
    runtime = await frozen.createRuntime({ rootDirectory });
    const frozenRetrieval = await import(
      pathToFileURL(
        join(
          prepared.runtimeDirectory,
          'src/plugins/proposer-operator/retrieval.js',
        ),
      ).href
    );
    const frozenRecipe = await readRecipe(prepared.recipePath);
    await frozenRetrieval.readEmbeddingIdentity(
      frozenRecipe.bindings.proposer.config.embedding,
      controller.signal,
    );
    await frozen.validateRecipe(runtime, prepared.recipePath);
    try {
      await runtime.manager.run(prepared.recipePath, {
        id: values.id,
        resume: values.resume,
        signal: controller.signal,
      });
    } catch (error) {
      failure = error;
    }
    summary = await summarizeOperatorExperiment(
      runtime.manager,
      values.id,
      prepared.manifestPath,
    );
    const auditedTiming = finalTimingStable(
      summary.bestMeasurement,
      summary.finalMeasurement,
    );
    if (summary.finalTimingStable !== auditedTiming)
      throw new Error(
        'Policy finalTimingStable disagrees with independently audited measurements',
      );
    Object.assign(summary, {
      ...assessSearchConfidence(
        calibration,
        summary.baselineMeasurement,
        summary.bestMeasurement,
        summary.finalMeasurement,
        minRelativeImprovement,
      ),
      calibration,
      finalTimingStable: auditedTiming,
      evidenceKind: 'device-observed',
      claim:
        'Observed search results; only improvementStatus=verified supports a calibrated, independently repeated performance gain.',
    });
    await writeFile(
      join(
        dirname(prepared.manifestPath),
        values.resume ? 'resume-summary.json' : 'summary.json',
      ),
      JSON.stringify(summary, null, 2) + '\n',
    );
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    if (
      !failure &&
      (summary.status !== 'succeeded' || summary.finalValidity !== 'valid')
    )
      failure = new Error('Search did not finish with a valid final source');
  } catch (error) {
    failure ??= error;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    try {
      await runtime?.dispose();
    } catch (error) {
      if (values.validate) throw error;
      failure ??= error;
    }
    try {
      await lease?.release(true);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) process.stderr.write(`${failure.stack ?? failure}\n`);
  return failure ? (controller.signal.aborted ? 130 : 1) : 0;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
