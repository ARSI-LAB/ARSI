import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readdir,
  access,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRuntime, type Runtime } from '../../src/runtime/context.js';
import { applicationContract } from '../../src/contracts/plugin-types/application.js';
import type { JsonObject } from '../../src/contracts/json.js';
import { doctorRecipe } from '../../src/runtime/doctor/index.js';
import { doctorScripts } from '../../src/runtime/doctor/scripts.js';
import type {
  DoctorReport,
  DoctorScript,
} from '../../src/runtime/doctor/types.js';
import { runCommand } from '../../src/runtime/doctor/process.js';
import { object } from '../../src/shared/json.js';

async function fixture(): Promise<{
  runtime: Runtime;
  root: string;
  path: string;
  dispose(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'doctor-test-'));
  const runtime = await createRuntime({
    homeDirectory: false,
    rootDirectory: root,
  });
  runtime.registry.registerOperation({
    id: 'test.application',
    contract: applicationContract,
    configSchema: {
      type: 'object',
      properties: { input: { type: 'string', 'x-rsi-path': 'file' } },
    },
    async create() {
      throw new Error('Doctor must not instantiate an uncovered plugin');
    },
  });
  const policy = join(root, 'policy.yaml');
  await writeFile(
    policy,
    JSON.stringify({
      schemaVersion: 'rsi.policy/v1',
      id: 'test.doctor',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: {
        left: { contract: 'contract.selector-metrics' },
        right: { contract: 'contract.selector-metrics' },
      },
      defaults: {
        bindings: {
          left: {
            plugin: 'selector.metric',
            config: { metric: 'score', direction: 'maximize' },
          },
          right: {
            plugin: 'selector.metric',
            config: { metric: 'cost', direction: 'minimize' },
          },
        },
      },
      steps: [],
      output: {},
    }),
  );
  runtime.registry.registerPolicy('test.doctor', policy);
  const path = join(root, 'recipe.yaml');
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 'rsi.recipe/v1',
      id: 'doctor-fixture',
      application: { plugin: 'test.application', config: {} },
      policy: { id: 'test.doctor' },
      bindings: { right: { config: { direction: 'maximize' } } },
    }),
  );
  return {
    runtime,
    root,
    path,
    async dispose() {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    },
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
}

test('bundled doctor covers exactly the 17 registered built-ins', async () => {
  const runtime = await createRuntime({ homeDirectory: false });
  try {
    assert.equal(Object.keys(doctorScripts).length, 17);
    assert.deepEqual(
      Object.keys(doctorScripts).sort(),
      runtime.registry.catalog().plugins.sort(),
    );
  } finally {
    await runtime.dispose();
  }
});

test('doctor checks effective per-binding overrides and reports uncovered implementations without experiments', async () => {
  const f = await fixture();
  try {
    const observed: string[] = [];
    const script: DoctorScript = async (ctx) => {
      await ctx.check('effective', async () => {
        observed.push(
          `${ctx.binding.name}:${ctx.binding.config.metric}:${ctx.binding.config.direction}`,
        );
      });
    };
    const report = await doctorRecipe(f.runtime, f.path, {
      scripts: { 'selector.metric': script },
    });
    assert.deepEqual(observed, ['left:score:maximize', 'right:cost:maximize']);
    assert.equal(report.summary.failed, 0);
    assert.match(
      report.checks.find((check) => check.id === 'application.plugin')
        ?.reason ?? '',
      /test.application/,
    );
    assert.deepEqual(await f.runtime.manager.list(), []);
    assert.deepEqual(await readdir(f.root), ['policy.yaml', 'recipe.yaml']);
    verifyReport(report);
  } finally {
    await f.dispose();
  }
});

test('doctor retains Recipe schema, Policy, binding, budget and Reflection validation before probes', async () => {
  const f = await fixture();
  try {
    const original = object(JSON.parse(await readFile(f.path, 'utf8')));
    const policyPath = join(f.root, 'policy.yaml');
    const policy = object(JSON.parse(await readFile(policyPath, 'utf8')));
    policy.config_schema = {
      type: 'object',
      additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1 } },
    };
    await writeFile(policyPath, JSON.stringify(policy));
    const invalid: {
      name: string;
      change(recipe: JsonObject): void;
      reason: RegExp;
    }[] = [
      {
        name: 'Recipe schema',
        change(recipe) {
          delete recipe.id;
        },
        reason: /recipe/,
      },
      {
        name: 'Policy registration',
        change(recipe) {
          object(recipe.policy).id = 'missing.policy';
        },
        reason: /missing.policy/,
      },
      {
        name: 'Policy configuration',
        change(recipe) {
          object(recipe.policy).config = { limit: 0 };
        },
        reason: /recipe.policy.config/,
      },
      {
        name: 'undeclared binding',
        change(recipe) {
          object(recipe.bindings).extra = {
            plugin: 'selector.metric',
            config: {},
          };
        },
        reason: /Binding extra/,
      },
      {
        name: 'binding contract',
        change(recipe) {
          object(object(recipe.bindings).right).plugin = 'agent.pi';
        },
        reason: /Binding right/,
      },
      {
        name: 'binding configuration',
        change(recipe) {
          object(object(object(recipe.bindings).right).config).direction =
            'sideways';
        },
        reason: /Binding right/,
      },
      {
        name: 'Application contract',
        change(recipe) {
          object(recipe.application).plugin = 'selector.metric';
        },
        reason: /Binding application/,
      },
      {
        name: 'budget',
        change(recipe) {
          recipe.budget = { operations: -1 };
        },
        reason: /budget.*operations/,
      },
      {
        name: 'Reflection authorization',
        change(recipe) {
          recipe.reflection = { configFile: 'missing.yaml' };
        },
        reason: /recipe.reflection/,
      },
    ];
    let probes = 0;
    const script: DoctorScript = async () => {
      probes++;
    };
    for (const scenario of invalid) {
      const data = structuredClone(original);
      scenario.change(data);
      await writeFile(f.path, JSON.stringify(data));
      const report = await doctorRecipe(f.runtime, f.path, {
        scripts: {
          'test.application': script,
          'selector.metric': script,
        },
      });
      assert.equal(report.recipeId, null, scenario.name);
      assert.deepEqual(
        report.summary,
        { passed: 0, failed: 1, unchecked: 0 },
        scenario.name,
      );
      assert.equal(report.checks[0].id, 'recipe.validate', scenario.name);
      assert.match(
        report.checks[0].reason ?? '',
        scenario.reason,
        scenario.name,
      );
      verifyReport(report);
    }
    assert.equal(probes, 0);
    assert.deepEqual(await f.runtime.manager.list(), []);
  } finally {
    await f.dispose();
  }
});

test('probe errors and deadlines preserve independent results, redact secrets and clean owned storage', async () => {
  const f = await fixture();
  const secret = 'doctor-test-secret-value';
  const previous = process.env.DOCTOR_TEST_API_KEY;
  const previousOrdinary = process.env.DOCTOR_VALUE;
  process.env.DOCTOR_TEST_API_KEY = secret;
  process.env.DOCTOR_VALUE = 'credential-with-ordinary-variable-name';
  let probeDirectory = '';
  let released = 0;
  try {
    const declaration = object(JSON.parse(await readFile(f.path, 'utf8')));
    object(object(declaration.application).config).api_key = '${DOCTOR_VALUE}';
    await writeFile(f.path, JSON.stringify(declaration));
    const report = await doctorRecipe(f.runtime, f.path, {
      timeoutMs: 10,
      scripts: {
        'test.application': async (ctx) => {
          probeDirectory = ctx.directory;
          await writeFile(join(ctx.directory, 'owned'), 'temporary');
          await ctx.check(
            'throws',
            async () => {
              throw new Error(`${secret} ${process.env.DOCTOR_VALUE}`);
            },
            {
              details: {
                availableBytes: 4096,
                requiredBytes: null,
                nested: [{ credential: process.env.DOCTOR_VALUE ?? '' }],
              },
            },
          );
          ctx.unchecked('depends-on-throw', 'The prerequisite probe failed.', {
            availableBytes: 4096,
            unknown: null,
            credential: secret,
          });
          await ctx.check('timeout', async (signal) => {
            try {
              await new Promise<void>((_done, reject) =>
                signal.addEventListener('abort', () => reject(signal.reason), {
                  once: true,
                }),
              );
            } finally {
              released++;
            }
          });
          ctx.unchecked(
            'depends-on-timeout',
            'The prerequisite probe timed out.',
          );
        },
        'selector.metric': async (ctx) => {
          await ctx.check('independent', async () => {});
        },
      },
    });
    assert.equal(report.summary.failed, 2);
    assert.equal(released, 1);
    assert.equal(report.missingResources.length, 0);
    assert.match(
      report.checks.find((check) => check.id === 'application.timeout')
        ?.reason ?? '',
      /timed out.*availability is unknown/,
    );
    assert.ok(
      report.checks.some(
        (check) =>
          check.id === 'right.independent' && check.status === 'passed',
      ),
    );
    assert.ok(!JSON.stringify(report).includes(secret));
    assert.ok(!JSON.stringify(report).includes(process.env.DOCTOR_VALUE));
    assert.equal(
      report.checks.find((check) => check.id === 'application.throws')?.details
        ?.availableBytes,
      4096,
    );
    assert.equal(
      report.checks.find((check) => check.id === 'application.depends-on-throw')
        ?.details?.unknown,
      null,
    );
    await assert.rejects(access(probeDirectory));
    assert.deepEqual(await f.runtime.manager.list(), []);
    verifyReport(report);
  } finally {
    if (previous === undefined) delete process.env.DOCTOR_TEST_API_KEY;
    else process.env.DOCTOR_TEST_API_KEY = previous;
    if (previousOrdinary === undefined) delete process.env.DOCTOR_VALUE;
    else process.env.DOCTOR_VALUE = previousOrdinary;
    await f.dispose();
  }
});

test('interruption cancels an owned subprocess, cleans storage and stops dispatch', async () => {
  const f = await fixture();
  const controller = new AbortController();
  let probeDirectory = '';
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  let independent = false;
  try {
    const result = doctorRecipe(f.runtime, f.path, {
      signal: controller.signal,
      scripts: {
        'test.application': async (ctx) => {
          probeDirectory = ctx.directory;
          await ctx.check('process', async (signal) => {
            const pending = runCommand(
              process.execPath,
              ['-e', 'setInterval(()=>{},1000)'],
              { signal },
            );
            entered();
            await pending;
          });
        },
        'selector.metric': async () => {
          independent = true;
        },
      },
    });
    await started;
    controller.abort(new Error('test interruption'));
    await assert.rejects(result, /test interruption/);
    assert.equal(independent, false);
    await assert.rejects(access(probeDirectory));
    assert.deepEqual(await f.runtime.manager.list(), []);
  } finally {
    await f.dispose();
  }
});

test('an aborted process probe closes its descendant process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doctor-process-tree-'));
  const controller = new AbortController();
  const marker = join(root, 'child-pid');
  const job = runCommand(
    process.execPath,
    [
      '-e',
      "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000);",
      marker,
    ],
    { signal: controller.signal },
  );
  // Attach rejection handling before aborting to avoid a transient unhandled rejection.
  const outcome = job.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    let descendant = 0;
    const deadline = Date.now() + 10000;
    while (!descendant && Date.now() < deadline) {
      descendant = Number(await readFile(marker, 'utf8').catch(() => '0'));
      if (!descendant) await new Promise((done) => setTimeout(done, 10));
    }
    assert.ok(descendant > 0, 'probe spawned its owned descendant');
    controller.abort(new Error('process-tree-test-abort'));
    assert.match(String(await outcome), /process-tree-test-abort/);
    assert.throws(() => process.kill(descendant, 0), /ESRCH/);
  } finally {
    controller.abort(new Error('test cleanup'));
    await outcome;
    await rm(root, { recursive: true, force: true });
  }
});

test('timeout diagnostics retain a probe cleanup failure and continue independent checks', async () => {
  const f = await fixture();
  try {
    const report = await doctorRecipe(f.runtime, f.path, {
      timeoutMs: 10,
      scripts: {
        'test.application': async (ctx) => {
          await ctx.check('cleanup-error', async (signal) => {
            try {
              await new Promise<void>((_done, reject) =>
                signal.addEventListener('abort', () => reject(signal.reason), {
                  once: true,
                }),
              );
            } finally {
              throw new Error('cleanup-fixture-failed');
            }
          });
        },
        'selector.metric': async (ctx) => {
          await ctx.check('independent', async () => {});
        },
      },
    });
    assert.match(
      report.checks.find((check) => check.id === 'application.cleanup-error')
        ?.reason ?? '',
      /timed out.*cleanup-fixture-failed/,
    );
    assert.equal(
      report.checks.find((check) => check.id === 'right.independent')?.status,
      'passed',
    );
    verifyReport(report);
  } finally {
    await f.dispose();
  }
});

test('CLI emits one JSON diagnostic for registration/loading errors and reports usage separately', async () => {
  const f = await fixture();
  const execute = promisify(execFile);
  const run = async (
    args: string[],
    env?: NodeJS.ProcessEnv,
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const result = await execute(
        process.execPath,
        ['--import', 'tsx', resolve('src/entries/cli/main.ts'), ...args],
        { cwd: process.cwd(), timeout: 30000, env },
      );
      return { code: 0, ...result };
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          'stdout' in error &&
          'stderr' in error &&
          'code' in error
        )
      )
        throw error;
      return {
        code: Number(error.code),
        stdout: String(error.stdout),
        stderr: String(error.stderr),
      };
    }
  };
  try {
    const broken = join(f.root, 'broken-extension');
    await mkdir(broken);
    await writeFile(
      join(broken, 'index.mjs'),
      "export function register(){throw new Error('broken-extension-fixture');}\n",
    );
    const registered = await run(['doctor', f.path, '--plugin-dir', broken]);
    assert.equal(registered.code, 1);
    assert.equal(registered.stderr, '');
    const report: DoctorReport = JSON.parse(registered.stdout);
    assert.equal(report.recipeId, null);
    assert.equal(report.checks[0].id, 'runtime.registration');
    const loaded = await run(['doctor', join(f.root, 'absent.yaml')]);
    assert.equal(loaded.code, 1);
    assert.equal(JSON.parse(loaded.stdout).checks[0].id, 'recipe.validate');
    assert.equal(loaded.stderr, '');
    const usage = await run(['doctor']);
    assert.equal(usage.code, 2);
    assert.equal(usage.stdout, '');
    const removed = await run(['validate', f.path]);
    assert.equal(removed.code, 2);
    assert.equal(removed.stdout, '');
    assert.match(removed.stderr, /unknown command 'validate'/);
    const help = await run(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /doctor/);
    assert.doesNotMatch(help.stdout, /\bvalidate\b/);
    const doctorHome = join(f.root, 'doctor-home');
    const fresh = await run(['doctor', join(f.root, 'absent.yaml')], {
      ...process.env,
      HOME: doctorHome,
      USERPROFILE: doctorHome,
    });
    assert.equal(fresh.code, 1);
    assert.equal(JSON.parse(fresh.stdout).checks[0].id, 'recipe.validate');
    await assert.rejects(access(join(doctorHome, '.ember-rsi')));
  } finally {
    await f.dispose();
  }
});
