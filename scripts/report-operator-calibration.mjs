#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { createRuntime } from '../dist/src/index.js';
import { reportCampaign } from '../dist/src/entries/cli/operator-experiments/campaign.js';
import { inspectOperatorInputs } from './operator-inputs.mjs';

const { values } = parseArgs({
  options: { help: { type: 'boolean' }, id: { type: 'string' } },
});
if (values.help)
  console.log(
    'Usage: node scripts/report-operator-calibration.mjs --id <campaign-id> (offline; no device execution)',
  );
else {
  let runtime;
  try {
    if (!values.id) throw new Error('Supply --id');
    const root = process.cwd();
    runtime = await createRuntime({ rootDirectory: root });
    const report = await reportCampaign({
      rootDirectory: root,
      id: values.id,
      manager: runtime.manager,
      prepare: async (entry) =>
        inspectOperatorInputs(
          join(root, '.rsi/operator-sdk', entry.id, 'manifest.json'),
        ),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.performance === 'passed' ? 0 : 1;
  } catch (error) {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  } finally {
    await runtime?.dispose();
  }
}
