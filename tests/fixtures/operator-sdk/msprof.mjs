#!/usr/bin/env node
// Test-only msprof boundary: synthetic CSV/trace and replay metadata; no NPU execution.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
const output = args
  .find((value) => value.startsWith('--output='))
  ?.slice('--output='.length);
const application = args
  .find((value) => value.startsWith('--application='))
  ?.slice('--application='.length);
const requestPath = application?.match(/--request ([^ ]+)/u)?.[1];
const resultPath = application?.match(/--output ([^ ]+)/u)?.[1];
if (!output || !requestPath || !resultPath)
  throw new Error('Missing fixture msprof arguments');
const request = JSON.parse(await readFile(requestPath, 'utf8'));
for (const [path, expected] of Object.entries(request.hashes)) {
  const actual = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  if (actual !== expected) throw new Error('Fixture diagnostic source changed');
}
const source = await readFile(request.candidate, 'utf8');
if (!source.includes('fixture:profile-unavailable')) {
  const profile = join(output, 'OPPROF_test_fixture');
  await mkdir(profile, { recursive: true });
  await writeFile(
    join(profile, 'PipeUtilization.csv'),
    'block_id,sub_block_id,aiv_vec_ratio,aiv_scalar_ratio,aiv_mte2_ratio,aiv_mte3_ratio,aiv_time(us)\n0,vector,0.7,0.2,0.4,0.1,10\n',
  );
  await writeFile(
    join(profile, 'L2Cache.csv'),
    'block_id,sub_block_id\n0,vector\n',
  );
  await writeFile(
    join(profile, 'ResourceConflictRatio.csv'),
    'block_id,aiv_vec_wait_ratio\n0,0.1\n',
  );
  if (!args.includes('--aic-metrics=Default'))
    await writeFile(
      join(profile, 'trace.json'),
      JSON.stringify({
        traceEvents: [{ pid: 'core0.veccore0', tid: 'VECTOR', ts: 0, dur: 10 }],
      }),
    );
  await writeFile(
    resultPath,
    JSON.stringify({
      seed: request.seeds[0],
      warmup: request.warmup,
      requestedLogicalDevice: 0,
      logicalDevice: 0,
      deviceCount: 1,
      capture: {
        method: 'mstx',
        range: 'rsi_operator_profile',
        toolId: 4097,
        rangeId: 0,
        warmupCompleted: request.warmup,
        callsInRange: 1,
      },
      deviceName: 'TEST-FIXTURE',
      inputContract: 'unchanged problem.get_inputs',
      environment: Object.fromEntries(
        [
          'python',
          'torch',
          'torchNpu',
          'triton',
          'cann',
          'driver',
          'device',
          'visibleDevices',
        ].map((key) => [key, 'TEST-FIXTURE']),
      ),
    }),
  );
}
