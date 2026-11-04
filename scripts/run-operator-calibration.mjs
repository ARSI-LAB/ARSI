#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../dist/src/index.js';
import {
  initializeCampaign,
  runCampaign,
  reportCampaign,
} from '../dist/src/entries/cli/operator-experiments/campaign.js';
import { inspectNpuHost } from '../dist/src/entries/cli/operator-experiments/preflight.js';
import {
  prepareOperatorInputs,
  inspectOperatorInputs,
  operatorBuildIdentity,
} from './operator-inputs.mjs';

const { values } = parseArgs({
  options: {
    help: { type: 'boolean' },
    id: { type: 'string' },
    preflight: { type: 'string' },
    recipe: { type: 'string' },
    resume: { type: 'boolean' },
    profile: { type: 'boolean' },
    'adjust-from': { type: 'string' },
    diagnosis: { type: 'string' },
  },
});
if (values.help) {
  console.log(
    'Usage: node scripts/run-operator-calibration.mjs --id <unique-id> --preflight <report.json> [--recipe <path>] [--profile] [--resume] [--adjust-from <campaign-id> --diagnosis <evidence.md>]',
  );
} else {
  const root = process.cwd(),
    controller = new AbortController();
  const abort = () => controller.abort(new Error('Interrupted'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let runtime;
  try {
    if (
      !values.id ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(values.id) ||
      !values.preflight
    )
      throw new Error('Supply --id and --preflight');
    if (
      values.resume &&
      (values.profile || values['adjust-from'] || values.diagnosis)
    )
      throw new Error(
        'Resume uses the frozen manifest; omit profile/adjustment options',
      );
    const preflight = JSON.parse(
      await readFile(resolve(values.preflight), 'utf8'),
    );
    if (
      preflight.schemaVersion !== 1 ||
      preflight.ready !== true ||
      preflight.host?.ready !== true ||
      preflight.smoke?.ready !== true ||
      preflight.smoke.cleanup !== 'confirmed' ||
      !preflight.platformChecks
    )
      throw new Error(
        'A completed device preflight and platform observations are required',
      );
    if (preflight.build?.digest !== (await operatorBuildIdentity()).digest)
      throw new Error(
        'Build changed since device preflight; run a new preflight',
      );
    const { python, device } = preflight.parameters;
    if (
      typeof python !== 'string' ||
      !Number.isSafeInteger(device) ||
      device < 0
    )
      throw new Error('Invalid preflight interpreter/device');
    const observe = () =>
      inspectNpuHost({
        rootDirectory: root,
        python,
        device,
        signal: controller.signal,
      });
    const current = await observe();
    if (!current.ready || current.identity !== preflight.host.identity)
      throw new Error('Preflight environment changed');
    const recipe = resolve(
      values.recipe ??
        fileURLToPath(
          new URL(
            '../examples/artifacts/kernel/qianchuan-top3/recipe.sdk.yaml',
            import.meta.url,
          ),
        ),
    );
    const prepare = async (entry, campaign, resume) => {
      const path = join(root, '.rsi/operator-sdk', entry.id, 'manifest.json');
      let snapshotExists = false;
      try {
        await access(path);
        snapshotExists = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await prepareOperatorInputs(recipe, root, entry.id, {
        mode: 'sdk',
        resume: resume || snapshotExists,
        entryScriptPath: fileURLToPath(import.meta.url),
        sdk: {
          python,
          device,
          profiling: entry.stage === 'profiling',
          protocol: { warmup: campaign.warmup, repeat: campaign.repeat },
        },
      });
      return inspectOperatorInputs(path);
    };
    if (!values.resume) {
      const adjusted = Boolean(values['adjust-from']);
      if (adjusted && !values.diagnosis)
        throw new Error('--adjust-from requires --diagnosis evidence file');
      const first = {
        id: adjusted ? `${values.id}-b1-p1` : `${values.id}-initial`,
        stage: adjusted ? 'batch-1' : 'initial',
      };
      const snapshot = await prepare(
        first,
        { warmup: adjusted ? 10 : 5, repeat: adjusted ? 100 : 20 },
        false,
      );
      runtime = await createRuntime({ rootDirectory: root });
      if (adjusted)
        await reportCampaign({
          rootDirectory: root,
          id: values['adjust-from'],
          manager: runtime.manager,
          prepare: async (entry) =>
            inspectOperatorInputs(
              join(root, '.rsi/operator-sdk', entry.id, 'manifest.json'),
            ),
        });
      await initializeCampaign({
        rootDirectory: root,
        id: values.id,
        hostIdentity: current.identity,
        inputIdentity: snapshot.identity,
        profiling: values.profile === true,
        preflight,
        ...(adjusted
          ? {
              adjustment: {
                parentId: values['adjust-from'],
                diagnosis: await readFile(resolve(values.diagnosis), 'utf8'),
              },
            }
          : {}),
      });
    }
    runtime ??= await createRuntime({ rootDirectory: root });
    const report = await runCampaign({
      rootDirectory: root,
      id: values.id,
      manager: runtime.manager,
      prepare,
      observe,
      resume: values.resume,
      signal: controller.signal,
      onProgress: (message) => console.log(message),
    });
    console.log(
      JSON.stringify(
        {
          id: report.id,
          basicLoop: report.basicLoop,
          performance: report.performance,
          profiling: report.profiling,
          recovery: report.recovery,
          evaluationRuns: report.evaluationRuns,
          reportPath: report.reportPath,
        },
        null,
        2,
      ),
    );
    process.exitCode = report.performance === 'passed' ? 0 : 1;
  } catch (error) {
    console.error(error.stack ?? error);
    process.exitCode = controller.signal.aborted ? 130 : 1;
    if (runtime && values.id)
      try {
        const report = await reportCampaign({
          rootDirectory: root,
          id: values.id,
          manager: runtime.manager,
          prepare: async (entry) =>
            inspectOperatorInputs(
              join(root, '.rsi/operator-sdk', entry.id, 'manifest.json'),
            ),
        });
        console.log(`Partial report: ${report.reportPath}`);
      } catch (reportError) {
        console.error(`Report unavailable: ${reportError.message}`);
      }
  } finally {
    await runtime?.dispose();
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
