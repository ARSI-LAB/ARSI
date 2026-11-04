#!/usr/bin/env node
// Test-only device worker. These durations and identities are synthetic fixtures.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
for (const [path, expected] of Object.entries(request.hashes)) {
  const actual = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  if (actual !== expected) throw new Error('Fixture locked source changed');
}
const source = await readFile(request.candidate, 'utf8');
const output = process.argv[process.argv.indexOf('--output') + 1];
if (source.includes('fixture:wait')) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output + '.started', 'Test fixture device worker started\n');
  await new Promise((resolve) => setTimeout(resolve, 30000));
}
const latency = Number(/fixture:latency=(\d+)/u.exec(source)?.[1] ?? 10);
const incorrect = source.includes('fixture:incorrect');
const unavailable = source.includes('fixture:infrastructure');
const ids = [
  'entry',
  'shape',
  'dtype',
  'device',
  'layout',
  'independent-output',
  'input-unmodified',
  'numerical',
];
const result = {
  schemaVersion: 1,
  candidateSha256: request.candidateSha256,
  referenceKind: request.referenceKind,
  timingScope: 'all-device-kernels',
  status: unavailable
    ? 'infrastructure_error'
    : incorrect
      ? 'incorrect'
      : 'passed',
  error: unavailable
    ? 'Test fixture infrastructure failure'
    : incorrect
      ? 'Test fixture numerical failure'
      : '',
  candidateMs: incorrect || unavailable ? null : latency,
  referenceMs: incorrect || unavailable ? null : 16,
  speedup: incorrect || unavailable ? null : 16 / latency,
  assessment: {
    schemaVersion: 1,
    contractSha256: request.contractSha256,
    checks: request.seeds.flatMap((seed) =>
      [0, 1].flatMap((call) =>
        ids.map((id) => ({
          id,
          seed,
          call,
          status: unavailable
            ? 'not-run'
            : incorrect && id === 'numerical'
              ? 'failed'
              : 'passed',
          message:
            incorrect && id === 'numerical' ? 'Test fixture mismatch' : '',
        })),
      ),
    ),
    effectiveProtocol: {
      seeds: request.seeds,
      rtol: request.rtol,
      atol: request.atol,
      warmup: request.warmup,
      repeat: request.repeat,
      timingScope: 'all-device-kernels',
      aggregation: 'iteration-mean',
      timingSeed: request.seeds.at(-1),
    },
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
    errorOwnership: unavailable ? 'evaluation' : incorrect ? 'candidate' : null,
  },
};
await mkdir(dirname(output), { recursive: true });
if (!incorrect && !unavailable) {
  const samples = {};
  for (const [name, meanMs] of [
    ['reference', 16],
    ['candidate', latency],
  ]) {
    const rows = Array.from(
      { length: request.warmup + request.repeat },
      (_, step) => ({
        step,
        device: '0',
        stream: '1',
        name: 'TEST-FIXTURE',
        startUs: step * 100000,
        durationUs: meanMs * 1000,
      }),
    );
    const csv =
      'Step Id,Device_id,Stream ID,Name,Start Time(us),Duration(us)\n' +
      rows
        .map((r) =>
          [r.step, r.device, r.stream, r.name, r.startUs, r.durationUs].join(
            ',',
          ),
        )
        .join('\n') +
      '\n';
    const csvPath = `profile-${name}/kernel_details.csv`;
    await mkdir(dirname(output) + `/profile-${name}`, { recursive: true });
    await writeFile(dirname(output) + '/' + csvPath, csv);
    const tracePath = `profile-${name}/trace_view.json`;
    const trace = JSON.stringify(
      rows.flatMap((r) => [
        {
          ph: 'X',
          name: `ProfilerStep#${r.step}`,
          pid: 1,
          tid: 1,
          ts: r.startUs,
          dur: 90000,
        },
        {
          ph: 'X',
          name: r.name,
          pid: 2,
          tid: 1,
          ts: r.startUs,
          dur: r.durationUs,
          args: { 'Task Type': 'AI_VECTOR_CORE' },
        },
        {
          ph: 's',
          name: 'torch_to_npu',
          cat: 'async_npu',
          id: `fixture-${r.step}`,
          pid: 1,
          tid: 1,
          ts: r.startUs + 1,
        },
        {
          ph: 'f',
          name: 'torch_to_npu',
          cat: 'async_npu',
          id: `fixture-${r.step}`,
          pid: 2,
          tid: 1,
          ts: r.startUs,
        },
      ]),
    );
    await writeFile(dirname(output) + '/' + tracePath, trace);
    samples[name] = {
      tracePath,
      traceSha256: createHash('sha256').update(trace).digest('hex'),
      csvPath,
      csvSha256: createHash('sha256').update(csv).digest('hex'),
      warmup: request.warmup,
      repeat: request.repeat,
      meanMs,
      rows,
    };
  }
  result.timingEvidence = {
    schemaVersion: 2,
    method: 'profiler-flow/v1',
    ...samples,
  };
}
await writeFile(output, JSON.stringify(result) + '\n');
process.stdout.write(JSON.stringify(result) + '\n');
