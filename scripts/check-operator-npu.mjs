#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { operatorBuildIdentity } from './operator-inputs.mjs';
import {
  inspectNpuHost,
  runNpuSmoke,
} from '../dist/src/entries/cli/operator-experiments/preflight.js';

const { values } = parseArgs({
  options: {
    help: { type: 'boolean' },
    python: { type: 'string' },
    device: { type: 'string' },
    id: { type: 'string' },
    smoke: { type: 'boolean' },
    'platform-checks': { type: 'string' },
  },
});
if (values.help) {
  console.log(
    'Usage: node scripts/check-operator-npu.mjs --id <unique-id> --python <path> --device <id> [--smoke --platform-checks <operator observation>]',
  );
} else {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Interrupted'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    if (
      !values.python ||
      !values.id ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(values.id) ||
      !/^\d+$/u.test(values.device ?? '')
    )
      throw new Error(
        'Supply explicit --id, --python and nonnegative --device',
      );
    if (values.smoke && !values['platform-checks']?.trim())
      throw new Error(
        'Before --smoke, record exclusive device access, persistent storage and session lifetime in --platform-checks',
      );
    const root = process.cwd();
    const directory = join(root, '.rsi/operator-preflight', values.id);
    await mkdir(join(root, '.rsi/operator-preflight'), { recursive: true });
    await mkdir(directory);
    const options = {
      rootDirectory: root,
      python: resolve(values.python),
      device: Number(values.device),
      signal: controller.signal,
    };
    const host = await inspectNpuHost(options);
    const execute = promisify(execFile);
    let dependencies;
    try {
      const result = await execute(
        process.execPath,
        [
          fileURLToPath(
            new URL('check-local-dependencies.mjs', import.meta.url),
          ),
        ],
        {
          cwd: root,
          timeout: 60000,
          maxBuffer: 1024 * 1024,
          signal: controller.signal,
        },
      );
      dependencies = { ready: true, output: result.stdout };
    } catch (error) {
      dependencies = { ready: false, error: error.message };
    }
    const build = await operatorBuildIdentity();
    const smoke =
      values.smoke && host.ready && dependencies.ready
        ? await runNpuSmoke({ ...options, directory: join(directory, 'smoke') })
        : null;
    const report = {
      schemaVersion: 1,
      build,
      ready: host.ready && dependencies.ready && smoke?.ready === true,
      host,
      dependencies,
      smoke,
      parameters: { python: options.python, device: options.device },
      platformChecks: values['platform-checks'] ?? null,
      observedAt: new Date().toISOString(),
      evaluationRuns: smoke?.evaluationRuns ?? 0,
    };
    const path = join(directory, 'report.json');
    await writeFile(path, JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
    });
    console.log(
      JSON.stringify(
        {
          reportPath: path,
          ready: report.ready,
          issues: host.issues,
          evaluationRuns: report.evaluationRuns,
        },
        null,
        2,
      ),
    );
    process.exitCode = report.ready ? 0 : 1;
  } catch (error) {
    console.error(error.stack ?? error);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
