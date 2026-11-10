import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { JsonObject, JsonValue } from '../../src/contracts/index.js';
import { createRuntime, type Runtime } from '../../src/runtime/context.js';
import { Recipe } from '../../src/runtime/loaders/recipe.js';
import { doctorRecipe } from '../../src/runtime/doctor/index.js';
import { doctorScripts } from '../../src/runtime/doctor/scripts.js';
import { createEvaluatorChecks } from '../../src/runtime/doctor/evaluator-checks.js';
import type {
  DoctorReport,
  DoctorScript,
} from '../../src/runtime/doctor/types.js';
import type { runCommand } from '../../src/runtime/doctor/process.js';
import { object } from '../../src/shared/json.js';

function selectedTasks(value: JsonValue): string[] {
  if (Array.isArray(value)) return value.flatMap(selectedTasks);
  if (value !== null && typeof value === 'object')
    return Object.entries(value).flatMap(([key, child]) =>
      /taskIds$/i.test(key) && Array.isArray(child)
        ? child.filter((item): item is string => typeof item === 'string')
        : selectedTasks(child),
    );
  return [];
}

async function fixture(
  t: TestContext,
  name: string,
): Promise<{
  root: string;
  path: string;
  runtime: Runtime;
  recipe: Recipe;
  data: JsonObject;
  calls: string[][];
  scripts: Readonly<Record<string, DoctorScript>>;
}> {
  const root = await mkdtemp(join(tmpdir(), `rsi-doctor-${name}-`));
  const variables = {
    MODEL_NAME: 'doctor-fixture-model',
    EVALUATOR_MODEL_NAME: 'doctor-fixture-model',
    MODEL_ENDPOINT: 'http://localhost:1234/v1',
    MODEL_API_KEY: 'doctor-harness-fixture-key-never-print',
    GEPA_WORKBUDDY_SOURCE: join(root, 'dataset'),
    GEPA_WORKBUDDY_CACHE: join(root, 'cache'),
    EVALUATOR_NETWORK_CONFIG: join(root, 'network.yaml'),
  };
  const previous = Object.fromEntries(
    Object.keys(variables).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, variables);
  const runtime = await createRuntime({
    homeDirectory: false,
    rootDirectory: root,
  });
  t.after(async () => {
    await runtime.dispose();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(variables.EVALUATOR_NETWORK_CONFIG, '{}\n');
  const recipe = await Recipe.load(
    resolve(`examples/harness/${name}/recipe.yaml`),
    runtime.registry,
  );
  const data = recipe.toJSON();
  const ids = [...new Set(selectedTasks(recipe.policyConfig))];
  assert.ok(ids.length > 0);
  const dataset = join(root, 'dataset');
  for (const [index, id] of ids.entries()) {
    const directory = join(dataset, 'tasks', String(index));
    await mkdir(join(directory, 'environment'), { recursive: true });
    await mkdir(join(directory, 'tests'));
    await writeFile(
      join(directory, 'task.toml'),
      `[task]\nname=${JSON.stringify(id)}\n[environment]\ndocker_image="doctor-task:cached"\nworkdir="/app"\ncpus=1\nmemory="32m"\n`,
    );
    await writeFile(
      join(directory, 'instruction.md'),
      'Deterministic local preflight metadata only.',
    );
    await writeFile(join(directory, 'tests/test.sh'), 'exit 0\n');
  }
  // Keep the real benchmark alias/version, selected task IDs, Application and
  // Policy resource origins. Only external dataset availability is substituted.
  const evaluator = object(object(data.bindings).evaluator);
  const config = object(evaluator.config);
  const benchmark = object(config.benchmark);
  const benchmarkConfig = object(benchmark.config ?? {});
  benchmark.config = {
    ...benchmarkConfig,
    cacheDir: join(root, 'cache'),
    source: { kind: 'local', path: dataset },
    tasks: {
      ...object(benchmarkConfig.tasks ?? {}),
      root: 'tasks',
      id: 'task.name',
      expectedCount: ids.length,
    },
  };
  const path = join(root, 'recipe.json');
  await writeFile(path, JSON.stringify(data));
  const calls: string[][] = [];
  const command: typeof runCommand = async (_executable, args) => {
    calls.push([...args]);
    return {
      stdout:
        args[0] === 'info'
          ? JSON.stringify({
              MemTotal: 8 * 1024 ** 3,
              NCPU: 8,
              OSType: 'linux',
              Architecture: 'x86_64',
              Driver: 'overlay2',
            })
          : '',
      stderr: '',
    };
  };
  return {
    root,
    path,
    runtime,
    recipe,
    data,
    calls,
    scripts: { ...doctorScripts, ...createEvaluatorChecks(command) },
  };
}

function verifyReport(report: DoctorReport): void {
  assert.equal(
    new Set(report.checks.map((check) => check.id)).size,
    report.checks.length,
  );
  for (const status of ['passed', 'failed', 'unchecked'] as const)
    assert.equal(
      report.summary[status],
      report.checks.filter((check) => check.status === status).length,
    );
  for (const resource of report.missingResources)
    for (const id of resource.checksNotRun)
      assert.equal(
        report.checks.find((check) => check.id === id)?.status,
        'unchecked',
      );
  assert.ok(
    !JSON.stringify(report).includes('doctor-harness-fixture-key-never-print'),
  );
}

const independentChecks = {
  'dsh-harness2': 'selector.prepare-project',
  'dsh-wikiskill': 'selector.configuration',
  'dsh-gepa': 'proposer.prepare-project',
};

for (const name of ['dsh-harness2', 'dsh-wikiskill', 'dsh-gepa'] as const) {
  test(`${name} doctor exercises its real baseline, Target and effective Policy resources`, async (t) => {
    const f = await fixture(t, name);
    const originalTarget = object(f.recipe.application.config.target).schema;
    assert.equal(typeof originalTarget, 'string');
    const targetBefore = await readFile(String(originalTarget));
    const report = await doctorRecipe(f.runtime, f.path, {
      scripts: f.scripts,
    });
    assert.equal(report.recipeId, f.recipe.id);
    assert.equal(
      report.summary.failed,
      0,
      JSON.stringify(
        report.checks.filter((check) => check.status === 'failed'),
      ),
    );
    for (const id of [
      'application.verify-bundle',
      'application.acquire-instance',
      'agent.model-config',
      'evaluator.task-metadata',
      'evaluator.docker-capacity',
      'evaluator.gateway-model-access',
      independentChecks[name],
    ])
      assert.equal(
        report.checks.find((check) => check.id === id)?.status,
        'passed',
        `${name}: ${id}`,
      );
    if (name === 'dsh-harness2') {
      assert.equal(
        report.checks.find((check) => check.id === 'reflection.prepare-project')
          ?.status,
        'passed',
      );
      assert.equal(
        report.checks.find(
          (check) => check.id === 'domainProposer.prepare-project',
        )?.status,
        'passed',
      );
    }
    if (name === 'dsh-gepa')
      assert.equal(
        report.checks.find((check) => check.id === 'search.baseline-modules')
          ?.status,
        'passed',
      );
    assert.deepEqual(await readFile(String(originalTarget)), targetBefore);
    assert.deepEqual(await f.runtime.manager.list(), []);
    assert.deepEqual(await f.runtime.context.facts.list('measurements'), []);
    await assert.rejects(access(join(f.root, '.rsi')));
    assert.ok(
      f.calls
        .filter((args) => args[0] === 'run')
        .every((args) => args.includes('--pull=never')),
    );
    assert.ok(
      f.calls.every(
        (args) => !args.includes('pull') && !args.includes('build'),
      ),
    );
    assert.equal(
      f.calls.filter((args) => args[0] === 'run').length,
      f.calls.filter((args) => args[0] === 'rm').length,
    );
    verifyReport(report);
  });

  test(`${name} missing baseline or Target preserves independent plugin checks`, async (t) => {
    const f = await fixture(t, name);
    for (const missing of ['baseline', 'target'] as const) {
      const data = structuredClone(f.data);
      const config = object(object(data.application).config);
      const resource = join(f.root, `missing-${missing}`);
      if (missing === 'baseline') config.baseline = { directory: resource };
      else config.target = { schema: resource };
      await writeFile(f.path, JSON.stringify(data));
      const report = await doctorRecipe(f.runtime, f.path, {
        scripts: f.scripts,
      });
      assert.ok(report.summary.failed > 0);
      assert.equal(
        report.checks.find((check) => check.id === 'application.baseline')
          ?.status,
        'failed',
      );
      assert.equal(
        report.checks.find((check) => check.id === 'application.verify-bundle')
          ?.status,
        'unchecked',
      );
      assert.equal(
        report.checks.find(
          (check) => check.id === 'application.acquire-instance',
        )?.status,
        'unchecked',
      );
      assert.equal(
        report.checks.find((check) => check.id === independentChecks[name])
          ?.status,
        'passed',
      );
      assert.equal(
        report.checks.find((check) => check.id === 'evaluator.docker')?.status,
        'passed',
      );
      assert.ok(
        report.missingResources.some((entry) => entry.reference === resource),
      );
      if (name === 'dsh-gepa' && missing === 'baseline')
        assert.equal(
          report.missingResources.find((entry) => entry.binding === 'search')
            ?.field,
          'application.config.baseline.directory',
        );
      verifyReport(report);
    }
    assert.deepEqual(await f.runtime.manager.list(), []);
    await assert.rejects(access(join(f.root, '.rsi')));
  });
}

test('identical scripted Recipe checks stay deterministic across two conversational latency goals', async (t) => {
  const f = await fixture(t, 'dsh-wikiskill');
  const selector = object(object(f.data.bindings).selector);
  selector.config = {
    metric: 'requestLatency',
    statistic: 'p99',
    direction: 'maximize',
  };
  await writeFile(f.path, JSON.stringify(f.data));
  const reduceLatency = await doctorRecipe(f.runtime, f.path, {
    scripts: f.scripts,
  });
  const increaseLatency = await doctorRecipe(f.runtime, f.path, {
    scripts: f.scripts,
  });
  assert.deepEqual(reduceLatency, increaseLatency);
  assert.equal(reduceLatency.summary.failed, 0);
  assert.equal(increaseLatency.summary.failed, 0);
  assert.equal(
    reduceLatency.checks.find((check) => check.id === 'selector.configuration')
      ?.status,
    'passed',
  );
  verifyReport(reduceLatency);
});
