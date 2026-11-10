import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Runs the installed CLI with a real extension outside the source checkout. */
export async function checkDoctorConsumer(command, workspace, environment) {
  const directory = join(workspace, 'doctor-consumer');
  const extension = join(directory, 'extension');
  await mkdir(extension, { recursive: true });
  await writeFile(
    join(extension, 'index.mjs'),
    `
import { fileURLToPath } from 'node:url';
export function register(registry) {
  registry.registerPolicy('consumer.doctor', fileURLToPath(new URL('./policy.yaml', import.meta.url)));
}
`,
  );
  await writeFile(
    join(extension, 'policy.yaml'),
    JSON.stringify({
      schemaVersion: 'rsi.policy/v1',
      id: 'consumer.doctor',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      require: { selector: { contract: 'contract.selector-metrics' } },
      defaults: {
        bindings: {
          selector: {
            plugin: 'selector.metric',
            config: { metric: 'score', direction: 'maximize' },
          },
        },
      },
      steps: [],
      output: { ready: true },
    }),
  );
  const baseline = join(directory, 'baseline');
  await mkdir(baseline);
  await writeFile(
    join(baseline, 'input.py'),
    'def kernel_function(x):\n    return x\n',
  );
  const recipe = {
    schemaVersion: 'rsi.recipe/v1',
    id: 'consumer-doctor',
    application: {
      plugin: 'application.kernel',
      config: {
        baseline: { directory: baseline },
        target: {
          schema: {
            schemaVersion: 'rsi.target/v1',
            id: 'consumer-kernel',
            entries: [
              {
                path: 'input.py',
                kind: 'file',
                description: 'Kernel source',
                changes: ['modify'],
              },
            ],
          },
        },
      },
    },
    policy: { id: 'consumer.doctor' },
  };
  const recipePath = join(directory, 'recipe.yaml');
  await writeFile(recipePath, JSON.stringify(recipe));
  const invoke = (file) => {
    try {
      return {
        code: 0,
        stdout: execFileSync(
          process.execPath,
          [command, 'doctor', file, '--plugin-dir', extension],
          {
            cwd: directory,
            env: environment,
            encoding: 'utf8',
            timeout: 30000,
            stdio: 'pipe',
          },
        ),
      };
    } catch (error) {
      assert.ok(
        error &&
          typeof error === 'object' &&
          'status' in error &&
          'stdout' in error,
      );
      assert.equal(String(error.stderr), '');
      return { code: error.status, stdout: String(error.stdout) };
    }
  };
  const valid = invoke(recipePath);
  assert.equal(valid.code, 0, valid.stdout);
  assert.equal(JSON.parse(valid.stdout).summary.failed, 0);
  await assert.rejects(
    access(join(directory, '.rsi')),
    'doctor does not create an invoking experiment store',
  );
  recipe.application.config.baseline.directory = join(directory, 'missing');
  const brokenPath = join(directory, 'broken.yaml');
  await writeFile(brokenPath, JSON.stringify(recipe));
  const broken = invoke(brokenPath);
  assert.equal(broken.code, 1);
  const report = JSON.parse(broken.stdout);
  assert.ok(
    report.missingResources.some(
      (resource) =>
        resource.reference === recipe.application.config.baseline.directory,
    ),
  );
  for (const resource of report.missingResources)
    for (const id of resource.checksNotRun)
      assert.equal(
        report.checks.find((check) => check.id === id)?.status,
        'unchecked',
      );
  const installed = new URL('../../', pathToFileURL(command));
  await access(new URL('runtime/doctor/evaluator-checks.js', installed));
  await access(new URL('plugins/proposer-optuna/python/worker.py', installed));
  console.log(
    'Installed doctor passed: extension loading, bundled scripts/assets, isolated lifecycle and missing-input JSON/exit status.',
  );
}
