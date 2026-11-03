import {
  HarborBenchmark,
  parseHarborConfig,
  PINNED_NODE_IMAGE,
} from 'ember-evaluator';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(root, '.outputs');
await mkdir(output, { recursive: true });
const exec = promisify(execFile);
const signal = AbortSignal.timeout(240000);
const cacheDir = resolve(
  process.env.TERMINALBENCH_CACHE ?? resolve(root, '.rsi/terminalbench-cache'),
);
const taskIds = process.argv.slice(2);
if (!taskIds.length) taskIds.push('terminal-bench/html-js-filter');
const benchmark = new HarborBenchmark(
  parseHarborConfig({
    dataset: 'terminal-bench@4.0.0',
    cacheDir,
    source: {
      kind: 'archive',
      url: 'https://github.com/harbor-framework/terminal-bench/releases/download/v4.0.0/terminal-bench-prebuilt-v4.0.0.tar.gz',
      sha256:
        '6d2c57cbcb1a75b5cdc0b0f989747fa68cdc65df8ff0a6893045a70ced7e668e',
      root: 'tasks',
    },
    tasks: { root: '.', id: 'task.name', expectedCount: 66 },
  }),
);
const report = {
  cacheDir,
  taskIds,
  sourceReady: false,
  tasks: [],
  dockerReady: false,
  endpointProbes: [],
  modelRequests: 0,
};
try {
  const source = await benchmark.resolveSource(null, signal);
  const refs = [];
  for await (const ref of benchmark.enumerate(source, signal))
    if (taskIds.includes(ref.id)) refs.push(ref);
  if (refs.length !== taskIds.length)
    throw new Error('Requested task IDs not found in pinned source');
  for (const ref of refs) {
    const task = await benchmark.prepare(ref, source, signal);
    // Do not expose verification payloads, hidden tests or answers to the proposer.
    report.tasks.push({
      id: ref.id,
      solveImage: task.solveEnv.image,
      verifyImage: task.verifyEnv?.image ?? null,
      workdir: task.solveEnv.workdir,
      solveNetwork: task.solveEnv.network ?? null,
      solveResources: task.solveEnv.resources ?? {},
      verifyResources: task.verifyEnv?.resources ?? {},
      serviceImages: Object.fromEntries(
        Object.entries(task.solveEnv.services ?? {}).map(([name, spec]) => [
          name,
          spec.image,
        ]),
      ),
    });
  }
  report.sourceRevision = source.revision;
  report.sourceReady = true;
  const docker = async (args, options = {}) =>
    exec('docker', args, { timeout: 60000, maxBuffer: 1000000, ...options });
  const info = await docker(['info', '--format', '{{.MemTotal}} {{.NCPU}}']);
  const [memoryBytes, cpus] = info.stdout.trim().split(/\s+/).map(Number);
  report.hostCapacity = { memoryBytes, cpus };
  const bytes = (value) => {
    if (value === undefined) return 0;
    const match = /^([0-9.]+)([bkmg]?)$/i.exec(String(value));
    if (!match)
      throw new Error('Unsupported memory unit in preflight: ' + value);
    return (
      Number(match[1]) *
      1024 ** Math.max(0, 'bkmg'.indexOf(match[2].toLowerCase() || 'b'))
    );
  };
  for (const task of report.tasks)
    for (const required of [task.solveResources, task.verifyResources]) {
      if ((required.cpus ?? 0) > cpus || bytes(required.memory) > memoryBytes)
        throw new Error(
          'Docker capacity cannot satisfy task resources: ' +
            JSON.stringify({ required, memoryBytes, cpus }),
        );
    }
  report.dockerContext =
    process.env.DOCKER_CONTEXT ?? '(current process default)';
  report.dockerReady = true;
  // This is the same pinned Node image used by the SDK model gateway.
  await docker(['image', 'inspect', PINNED_NODE_IMAGE]).catch(() =>
    docker(['pull', '--platform', 'linux/amd64', PINNED_NODE_IMAGE], {
      timeout: 180000,
    }),
  );
  const mountName = 'rsi-mount-preflight-' + process.pid + '-' + Date.now();
  try {
    await docker([
      'run',
      '--rm',
      '--name',
      mountName,
      '--platform',
      'linux/amd64',
      '--mount',
      `type=bind,source=${root},target=/owned,readonly`,
      '--mount',
      `type=bind,source=${cacheDir},target=/cache,readonly`,
      PINNED_NODE_IMAGE,
      'node',
      '-e',
      "const f=require('node:fs');f.accessSync('/owned/terminalbench-preflight.mjs');f.accessSync('/cache/objects');console.log(process.platform+'/'+process.arch)",
    ]);
    report.workspaceAndCacheMounts = true;
  } finally {
    await docker(['rm', '-f', mountName]).catch(() => {});
  }
  const origin = process.env.MODEL_ENDPOINT;
  if (!origin || !process.env.MODEL_API_KEY)
    throw new Error(
      'MODEL_ENDPOINT and MODEL_API_KEY are required for authenticated no-inference probe',
    );
  const mapped = new URL(origin);
  if (['localhost', '127.0.0.1', '[::1]'].includes(mapped.hostname))
    mapped.hostname = 'host.docker.internal';
  const candidates = [
    ...new Set(
      [process.env.SOLVER_MODEL_ENDPOINT, mapped.href].filter(Boolean),
    ),
  ];
  const probe = `let text='';for await(const c of process.stdin)text+=c;const x=JSON.parse(text);try{const u=new URL(x.endpoint.replace(/\\/$/,'')+'/models');const r=await fetch(u,{headers:{authorization:'Bearer '+x.key},signal:AbortSignal.timeout(10000)});const b=await r.json();console.log(JSON.stringify({status:r.status,modelAvailable:Array.isArray(b.data)&&b.data.some(m=>m.id===x.model)}));if(!r.ok)process.exitCode=2;}catch(e){console.log(JSON.stringify({error:e.message}));process.exitCode=2;}`;
  for (const endpoint of candidates) {
    const name = 'rsi-model-preflight-' + process.pid + '-' + Date.now();
    try {
      // Credentials travel through stdin, never command arguments or logs.
      const args = [
        'run',
        '--rm',
        '-i',
        '--name',
        name,
        '--platform',
        'linux/amd64',
        '--add-host',
        'host.docker.internal:host-gateway',
        PINNED_NODE_IMAGE,
        'node',
        '-e',
        probe,
      ];
      const result = await new Promise((done, fail) => {
        const child = execFile(
          'docker',
          args,
          { timeout: 30000, maxBuffer: 1000000 },
          (error, stdout) => {
            if (error)
              fail(
                Object.assign(new Error('Container endpoint probe failed'), {
                  stdout,
                }),
              );
            else done({ stdout });
          },
        );
        child.stdin.end(
          JSON.stringify({
            endpoint,
            key: process.env.MODEL_API_KEY,
            model: process.env.MODEL_NAME,
          }),
        );
      });
      const response = JSON.parse(result.stdout.trim());
      report.endpointProbes.push({ endpoint, ...response });
      if (response.status === 200 && response.modelAvailable) {
        report.solverEndpoint = endpoint;
        break;
      }
    } catch (error) {
      report.endpointProbes.push({
        endpoint,
        error: error.message,
        response: error.stdout?.trim(),
      });
    } finally {
      await docker(['rm', '-f', name]).catch(() => {});
    }
  }
  report.readyForBoundedEvaluation =
    report.sourceReady && report.dockerReady && Boolean(report.solverEndpoint);
  if (!report.readyForBoundedEvaluation) process.exitCode = 2;
} catch (error) {
  report.error = error.message;
  report.readyForBoundedEvaluation = false;
  process.exitCode = 2;
} finally {
  await writeFile(
    resolve(output, 'terminalbench-preflight.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
}
