#!/usr/bin/env node
// Explicit CPU integration: real Agent and embeddings, synthetic SDK assessment/timing only.
import { cp, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parse, stringify } from 'yaml';
import {
  operatorBuildIdentity,
  summarizeOperatorExperiment,
} from './operator-inputs.mjs';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean' },
      id: { type: 'string' },
      'model-config': { type: 'string' },
      'embedding-python': { type: 'string' },
      'model-directory': { type: 'string' },
      'embedding-identity': { type: 'string' },
      'max-attempts': { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'Usage: node scripts/integration-operator-search.mjs --id <unique-id> --model-config <private-json> --embedding-python <python> --model-directory <weights> --embedding-identity <json> [--max-attempts <1..3>]\nRuns real agent.pi and local embedding with synthetic SDK protocol fixtures. No NPU, precision, performance or deployment qualification is established.\n',
    );
    return 0;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(values.id ?? ''))
    throw new Error('Supply a safe unique --id');
  for (const field of [
    'model-config',
    'embedding-python',
    'model-directory',
    'embedding-identity',
  ])
    if (!values[field]) throw new Error(`Supply --${field}`);
  const attempts = Number(values['max-attempts'] ?? 3);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3)
    throw new Error('--max-attempts must be 1..3');
  const credential = JSON.parse(
    await readFile(resolve(values['model-config']), 'utf8'),
  );
  for (const field of ['model', 'base_url', 'api_key'])
    if (typeof credential[field] !== 'string' || !credential[field])
      throw new Error(`Private model config requires ${field}`);
  const directory = join(process.cwd(), '.rsi/operator-functional', values.id);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
  const source = join(
    packageDirectory,
    'examples/artifacts/kernel/qianchuan-top3',
  );
  const example = join(directory, 'example'),
    runtimeDirectory = join(directory, 'runtime'),
    workspace = join(directory, 'workspace');
  const build = await operatorBuildIdentity();
  await cp(source, example, { recursive: true });
  await cp(join(packageDirectory, 'dist'), runtimeDirectory, {
    recursive: true,
  });
  const worker = join(directory, 'sdk-protocol-fixture.mjs');
  await cp(
    join(packageDirectory, 'tests/fixtures/operator-sdk/worker.mjs'),
    worker,
  );
  await chmod(worker, 0o755);
  const identity = join(directory, 'embedding-identity.json');
  await cp(resolve(values['embedding-identity']), identity);
  const recipePath = join(example, 'recipe.functional.yaml');
  const recipe = parse(
    await readFile(join(example, 'recipe.search.yaml'), 'utf8'),
  );
  recipe.id = values.id;
  recipe.policy.config.maxAttempts = attempts;
  recipe.policy.config.metricsEnabled = false;
  recipe.budget = {
    ...recipe.budget,
    operations: 256,
    evaluationRuns: 14,
    modelCalls: 32,
    elapsedWallMs: 2400000,
  };
  Object.assign(recipe.bindings.agent.config, {
    model: credential.model,
    base_url: credential.base_url,
    api_key: '${RSI_OPERATOR_INTEGRATION_API_KEY}',
    retries: 0,
  });
  Object.assign(recipe.bindings.proposer.config.embedding, {
    python: values['embedding-python'],
    modelDirectory: resolve(values['model-directory']),
    identityFile: identity,
  });
  recipe.bindings.evaluator.config.sdk.python = worker;
  recipe.bindings.evaluator.config.sdk.timeoutSeconds = 30;
  await writeFile(recipePath, stringify(recipe));
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 'rsi.operator-functional/v1',
        id: values.id,
        evidenceKind: 'test-fixture',
        performanceQualified: false,
        model: credential.model,
        build,
        embeddingIdentityFile: identity,
        recipePath,
        sdkWorker: worker,
        claim:
          'Agent/embedding/Policy integration only; all SDK precision and timing results are synthetic.',
      },
      null,
      2,
    ) + '\n',
  );
  const keyName = 'RSI_OPERATOR_INTEGRATION_API_KEY',
    previousKey = process.env[keyName];
  process.env[keyName] = credential.api_key;
  const { createRuntime, validateRecipe } = await import(
    pathToFileURL(join(runtimeDirectory, 'src/index.js')).href
  );
  const { readEmbeddingIdentity } = await import(
    pathToFileURL(
      join(runtimeDirectory, 'src/plugins/proposer-operator/retrieval.js'),
    ).href
  );
  const { finalTimingStable } = await import(
    pathToFileURL(
      join(runtimeDirectory, 'src/entries/cli/operator-experiments/search.js'),
    ).href
  );
  const runtime = await createRuntime({ rootDirectory: workspace }),
    controller = new AbortController();
  const abort = () => controller.abort(new Error('Interrupted'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let failure;
  try {
    await readEmbeddingIdentity(
      recipe.bindings.proposer.config.embedding,
      controller.signal,
    );
    await validateRecipe(runtime, recipePath);
    try {
      await runtime.manager.run(recipePath, {
        id: values.id,
        signal: controller.signal,
      });
    } catch (error) {
      failure = error;
    }
    const summary = await summarizeOperatorExperiment(
      runtime.manager,
      values.id,
      join(directory, 'manifest.json'),
    );
    const experiment = await runtime.manager.get(values.id),
      output = experiment.output;
    const initial = experiment.application.initialCandidateRef;
    const calls = (await runtime.manager.facts.list('calls')).filter(
      (call) => call.experimentId === values.id,
    );
    const analysis =
      typeof output?.analysisRef === 'string'
        ? await runtime.manager.artifacts.readJson(output.analysisRef)
        : null;
    const generatedCandidates = (output?.attempts ?? [])
      .flatMap((attempt) => attempt.candidateRefs)
      .filter((ref) => ref !== initial);
    const beforeResume = JSON.stringify({
      calls,
      measurements: await runtime.manager.facts.list('measurements'),
      usage: experiment.usage,
    });
    let completedResumeUnchanged = false;
    if (experiment.status === 'succeeded') {
      await runtime.manager.run(recipePath, {
        id: values.id,
        resume: true,
        signal: controller.signal,
      });
      completedResumeUnchanged =
        beforeResume ===
        JSON.stringify({
          calls: (await runtime.manager.facts.list('calls')).filter(
            (call) => call.experimentId === values.id,
          ),
          measurements: await runtime.manager.facts.list('measurements'),
          usage: (await runtime.manager.get(values.id)).usage,
        });
    }
    const checks = {
      policySucceeded: experiment.status === 'succeeded',
      realAgentCalled: calls.some(
        (call) => call.pluginId === 'agent.pi' && call.status === 'succeeded',
      ),
      sourceDiagnosisObserved:
        Array.isArray(analysis?.issues) && analysis.issues.length > 0,
      generationObserved: generatedCandidates.length > 0,
      finalTimingStable:
        finalTimingStable(summary.bestMeasurement, summary.finalMeasurement) ===
        true,
      completedResumeUnchanged,
      cleanupConfirmed:
        summary.unreleasedInstances.length === 0 &&
        summary.unconfirmedOrFailedCalls.length === 0,
    };
    Object.assign(summary, {
      evidenceKind: 'test-fixture',
      performanceQualified: false,
      claim:
        'Real Agent, local embedding and Policy integration. SDK correctness and timings are synthetic fixtures; candidate precision and performance remain unverified on NPU.',
      checks,
    });
    await writeFile(
      join(directory, 'summary.json'),
      JSON.stringify(summary, null, 2) + '\n',
    );
    process.stdout.write(
      JSON.stringify(
        {
          directory,
          status: experiment.status,
          usage: experiment.usage,
          checks,
          evidenceKind: 'test-fixture',
          performanceQualified: false,
        },
        null,
        2,
      ) + '\n',
    );
    if (!Object.values(checks).every(Boolean))
      failure ??= new Error(
        'CPU integration acceptance is incomplete; inspect summary.json and Manager facts',
      );
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    await runtime.dispose();
    if (previousKey === undefined) delete process.env[keyName];
    else process.env[keyName] = previousKey;
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
