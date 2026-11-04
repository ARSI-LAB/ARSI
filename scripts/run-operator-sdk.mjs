#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  prepareOperatorInputs,
  summarizeOperatorExperiment,
} from './operator-inputs.mjs';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
/** A successful Policy can still report unavailable diagnostics; the CLI makes that actionable. */
export function describeSdkOutcome(summary) {
  if (summary.stopReason === 'diagnostic-only')
    return {
      claim:
        'Baseline assessment and independent diagnostic collection; no final retiming or optimization claim.',
      exitCode: summary.collectionStatus === 'completed' ? 0 : 1,
    };
  return {
    claim:
      'Baseline evaluation and independent re-evaluation; no code optimization claim.',
    exitCode: 0,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = {
    id: 'operator-top3-sdk',
    resume: false,
    profiling: false,
    recipe: join(
      packageDirectory,
      'examples/artifacts/kernel/qianchuan-top3/recipe.sdk.yaml',
    ),
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help') {
      process.stdout.write(
        'Usage: node scripts/run-operator-sdk.mjs --python <interpreter> --device <physical-device-id> [--id <id>] [--recipe <path>] [--profile] [--msprof-bin <path>] [--resume]\n',
      );
      return 0;
    }
    if (flag === '--resume') options.resume = true;
    else if (flag === '--profile') options.profiling = true;
    else if (
      ['--id', '--recipe', '--python', '--device', '--msprof-bin'].includes(
        flag,
      )
    ) {
      const value = argv[++index];
      if (!value || value.startsWith('--'))
        throw new Error(`${flag} requires a value`);
      options[flag.slice(2)] = value;
    } else throw new Error(`Unknown option ${flag}`);
  }
  if (
    !options.python ||
    options.device === undefined ||
    !/^\d+$/u.test(options.device)
  )
    throw new Error('Supply explicit --python and nonnegative --device');
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 22 || (minor === 22 && patch < 1))
    throw new Error('Evaluator requires Node >=24.22.1 <25');
  const prepared = await prepareOperatorInputs(
    options.recipe,
    process.cwd(),
    options.id,
    {
      mode: 'sdk',
      resume: options.resume,
      entryScriptPath: fileURLToPath(import.meta.url),
      sdk: {
        python: options.python,
        device: Number(options.device),
        profiling: options.profiling,
        ...(options['msprof-bin'] === undefined
          ? {}
          : { msprofBin: resolve(options['msprof-bin']) }),
      },
    },
  );
  const { createRuntime, validateRecipe } = await import(
    pathToFileURL(join(prepared.runtimeDirectory, 'src/index.js')).href
  );
  const runtime = await createRuntime({ rootDirectory: process.cwd() });
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Interrupted'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let failure;
  try {
    await validateRecipe(runtime, prepared.recipePath);
    await runtime.manager.run(prepared.recipePath, {
      id: options.id,
      resume: options.resume,
      signal: controller.signal,
    });
  } catch (error) {
    failure = error;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    await runtime.dispose();
  }
  const summary = await summarizeOperatorExperiment(
    runtime.manager,
    options.id,
    prepared.manifestPath,
  );
  const manifest = JSON.parse(await readFile(prepared.manifestPath, 'utf8'));
  summary.mode = 'sdk';
  summary.executionParameters = manifest.executionParameters;
  const outcome = describeSdkOutcome(summary);
  summary.claim = outcome.claim;
  summary.evidenceKind = summary.recordedMeasurements.some((m) =>
    Object.values(m?.conditions?.evaluation?.environment ?? {}).includes(
      'TEST-FIXTURE',
    ),
  )
    ? 'test-fixture'
    : 'device-observed';
  await writeFile(
    join(
      dirname(prepared.manifestPath),
      options.resume ? 'resume-summary.json' : 'summary.json',
    ),
    JSON.stringify(summary, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  if (failure) process.stderr.write(`${failure.stack ?? failure}\n`);
  return failure ? (controller.signal.aborted ? 130 : 1) : outcome.exitCode;
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
