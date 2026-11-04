import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus, hostname, totalmem } from 'node:os';
import { readFile, mkdir, statfs, writeFile, glob } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseKernelTimingEvidence,
  auditKernelTimingSample,
} from 'ember-evaluator';
import { prepareSdkConfiguration } from '../../../plugins/evaluator-operatorbench/sdk-configuration.js';
import { runOperatorSdk } from '../../../plugins/evaluator-operatorbench/sdk-runner.js';
import {
  adaptSdkResult,
  type SdkOperatorResult,
} from '../../../plugins/evaluator-operatorbench/sdk-result.js';
import { digest, object, string } from '../../../shared/json.js';
import type { JsonObject } from '../../../contracts/index.js';
import { acquireDeviceSession } from './device-session.js';

const execute = promisify(execFile);
type Observation = { status: 'observed' | 'unavailable'; output: string };
export type HostReport = {
  schemaVersion: 1;
  ready: boolean;
  identity: string;
  observedAt: string;
  host: JsonObject;
  python: JsonObject | null;
  deviceQuery: Observation;
  boardQuery: Observation;
  profiler: Observation;
  issues: string[];
};
export async function inspectNpuHost(options: {
  rootDirectory: string;
  python: string;
  device: number;
  signal?: AbortSignal;
}): Promise<HostReport> {
  if (!Number.isSafeInteger(options.device) || options.device < 0)
    throw new Error('Invalid NPU device');
  options.signal?.throwIfAborted();
  const observe = async (
    file: string,
    args: string[],
  ): Promise<Observation> => {
    try {
      const result = await execute(file, args, {
        timeout: 15000,
        maxBuffer: 256 * 1024,
        signal: options.signal,
      });
      return {
        status: 'observed',
        output: (result.stdout + result.stderr).trim(),
      };
    } catch (error) {
      options.signal?.throwIfAborted();
      return {
        status: 'unavailable',
        output: (error instanceof Error ? error.message : String(error)).slice(
          0,
          2000,
        ),
      };
    }
  };
  const pythonCode = `import importlib.metadata as m,json,sys,platform
def version(name):
 try: return m.version(name)
 except m.PackageNotFoundError: return None
print(json.dumps({'executable':sys.executable,'version':platform.python_version(),'torch':version('torch'),'torchNpu':version('torch-npu'),'triton':version('triton-ascend')}))`;
  const [pythonQuery, deviceQuery, boardQuery, profiler, pnpm] =
    await Promise.all([
      observe(options.python, ['-c', pythonCode]),
      observe('npu-smi', ['info']),
      observe('npu-smi', ['info', '-t', 'board', '-i', String(options.device)]),
      observe(
        join(
          process.env.ASCEND_HOME_PATH ??
            '/usr/local/Ascend/ascend-toolkit/latest',
          'bin/msprof',
        ),
        ['--version'],
      ),
      observe('pnpm', ['--version']),
    ]);
  let python: JsonObject | null = null;
  const issues: string[] = [];
  try {
    if (pythonQuery.status === 'observed')
      python = object(JSON.parse(pythonQuery.output));
  } catch {
    /* Report malformed external output explicitly below. */
  }
  if (
    !python ||
    ['executable', 'version', 'torch', 'torchNpu', 'triton'].some(
      (k) => typeof python?.[k] !== 'string' || !python[k],
    )
  )
    issues.push('Python interpreter or required packages unavailable');
  if (deviceQuery.status !== 'observed')
    issues.push('NPU device query unavailable');
  if (pnpm.status !== 'observed' || pnpm.output !== '11.22.0')
    issues.push('pnpm 11.22.0 is required');
  if (!/950\s*PR/iu.test(deviceQuery.output))
    issues.push('Ascend 950PR device identity not observed');
  const board = Object.fromEntries(
    boardQuery.output.split('\n').flatMap((line) => {
      const match =
        /^\s*(Software Version|Firmware Version|Compatibility|PCIe Bus Info|Serial Number)\s*:\s*(.+?)\s*$/u.exec(
          line,
        );
      return match ? [[match[1], match[2]]] : [];
    }),
  );
  if (
    boardQuery.status !== 'observed' ||
    !board['Firmware Version'] ||
    !board['Software Version']
  )
    issues.push('NPU firmware or driver identity unavailable');
  if (board.Compatibility && board.Compatibility !== 'OK')
    issues.push('NPU board compatibility is not OK');
  let osRelease: string | null = null;
  try {
    osRelease = await readFile('/etc/os-release', 'utf8');
  } catch {
    issues.push('OS release unavailable');
  }
  if (!/openeuler/iu.test(osRelease ?? ''))
    issues.push('openEuler is required for this calibration target');
  const cannHome =
    process.env.ASCEND_HOME_PATH ?? '/usr/local/Ascend/ascend-toolkit/latest';
  let cann: string | null = null;
  for (const relative of [
    'version.cfg',
    'aarch64-linux/ascend_toolkit_install.info',
    'x86_64-linux/ascend_toolkit_install.info',
  ]) {
    try {
      cann = await readFile(join(cannHome, relative), 'utf8');
      break;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
    }
  }
  if (!/\b9\.1\.0\b/u.test(cann ?? ''))
    issues.push('CANN 9.1.0 release descriptor unavailable or incompatible');
  if (process.platform !== 'linux') issues.push('Linux is required');
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 22 || (minor === 22 && patch < 1))
    issues.push('Node >=24.22.1 <25 is required');
  await mkdir(options.rootDirectory, { recursive: true });
  const disk = await statfs(options.rootDirectory);
  const host = {
    name: hostname(),
    platform: process.platform,
    architecture: process.arch,
    osRelease,
    node: process.version,
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
    availableStorageBytes: disk.bavail * disk.bsize,
    device: options.device,
    cann,
    pnpm: pnpm.output,
  };
  return {
    schemaVersion: 1,
    ready: issues.length === 0,
    identity: digest({
      python,
      board,
      device: options.device,
      hostname: hostname(),
      architecture: process.arch,
      osRelease,
      node: process.version,
      cann,
      pnpm: pnpm.output,
      profiler,
      visibleDevices: process.env.ASCEND_RT_VISIBLE_DEVICES ?? null,
      visibleDevicesLegacy: process.env.ASCEND_VISIBLE_DEVICES ?? null,
    }),
    observedAt: new Date().toISOString(),
    host,
    python,
    deviceQuery,
    boardQuery,
    profiler,
    issues,
  };
}

export type SmokeReport = {
  ready: boolean;
  status: string;
  evaluationRuns: number;
  runId: string | null;
  cleanup: string;
  environment: JsonObject | null;
  resultPath: string;
  error: string | null;
};
type SmokeOptions = {
  rootDirectory: string;
  directory: string;
  python: string;
  device: number;
  signal?: AbortSignal;
};
export async function runNpuSmoke(options: SmokeOptions): Promise<SmokeReport> {
  const lease = await acquireDeviceSession({
    rootDirectory: options.rootDirectory,
    owner: `smoke:${options.directory}`,
  });
  let submitted = false,
    confirmed = false;
  try {
    const result = await executeSmoke(options, () => {
      submitted = true;
    });
    confirmed =
      result.cleanup === 'confirmed' || result.cleanup === 'not-started';
    return result;
  } finally {
    await lease.release(!submitted || confirmed);
  }
}
async function executeSmoke(
  options: SmokeOptions,
  onSubmit: () => void,
): Promise<SmokeReport> {
  // Elementwise arithmetic gives both implementations a device kernel; clone may use DMA only.
  await mkdir(options.directory, { recursive: true });
  const problem = `import torch\nimport torch_npu\nclass Model(torch.nn.Module):\n def forward(self,x): return x + 1\ndef get_inputs(): return [torch.arange(1024,device='npu',dtype=torch.float16)]\n`;
  const source = `import torch\nimport torch_npu\nimport triton\nimport triton.language as tl\n@triton.jit\ndef add_one_kernel(x,y,N:tl.constexpr,B:tl.constexpr):\n i=tl.program_id(0)*B+tl.arange(0,B)\n tl.store(y+i,tl.load(x+i,i<N,0)+1,i<N)\ndef kernel_function(x):\n y=torch.empty_like(x)\n add_one_kernel[(4,)](x,y,1024,256)\n return y\n`;
  await writeFile(join(options.directory, 'problem.py'), problem, {
    flag: 'wx',
  });
  await writeFile(join(options.directory, 'input.py'), source, { flag: 'wx' });
  const config = {
    mode: 'sdk' as const,
    task: { directory: options.directory },
    protocol: {
      warmup: 1,
      repeat: 2,
      rtol: 0,
      atol: 0,
      timingScope: 'all-device-kernels' as const,
    },
    sdk: {
      python: options.python,
      device: options.device,
      timeoutSeconds: 120,
      profiling: { enabled: false },
    },
  };
  const prepared = await prepareSdkConfiguration(
    config,
    {
      inputs: [{ shape: [1024], dtype: 'float16' }],
      output: {
        shape: [1024],
        dtype: 'float16',
        contiguous: true,
        independent: true,
      },
      inputUnmodified: true,
    },
    { id: 'fixed', seed: 42 },
    {
      directory: options.directory,
      sourceDigest: createHash('sha256').update(source).digest('hex'),
    },
    options.directory,
  );
  const signal = options.signal ?? new AbortController().signal;
  const resultPath = join(options.directory, 'smoke-result.json');
  let native: unknown = null;
  let result: SdkOperatorResult | null = null;
  let evaluationRuns = 0;
  try {
    signal.throwIfAborted();
    onSubmit();
    evaluationRuns = 1;
    native = await runOperatorSdk(prepared, signal);
    await writeFile(resultPath, JSON.stringify(native, null, 2) + '\n');
    result = adaptSdkResult(native, prepared, config, 42);
    if (result.valid !== true)
      throw new Error(
        result.diagnostics.map((d) => d.message).join('; ') ||
          'SDK smoke failed',
      );
    const snapshot = object(object(native).snapshot);
    if (!Array.isArray(snapshot.records))
      throw new Error('Missing smoke SDK records');
    const details = object(object(object(snapshot.records[0]).verdict).details);
    const timing = parseKernelTimingEvidence(details.timingEvidence);
    const runDirectory = string(object(native).runDirectory);
    let audited = 0;
    for await (const file of glob(
      'tasks/*/attempts/*/verifier/kernel-result.json',
      { cwd: runDirectory },
    )) {
      const verifier = dirname(join(runDirectory, file));
      if (basename(dirname(verifier)) !== result.attemptId) continue;
      const raw = object(
        JSON.parse(
          await readFile(join(verifier, 'kernel-result.json'), 'utf8'),
        ),
      );
      if (
        digest(raw.timingEvidence) !== digest(details.timingEvidence) ||
        digest(raw.assessment) !== digest(details.assessment)
      )
        throw new Error('Smoke raw evidence mismatch');
      for (const sample of [timing.reference, timing.candidate])
        auditKernelTimingSample(
          sample,
          await readFile(join(verifier, sample.csvPath)),
          await readFile(join(verifier, sample.tracePath)),
        );
      audited++;
    }
    if (audited !== 1)
      throw new Error('Smoke raw timing evidence missing or ambiguous');
    const environment = object(result.assessment?.environment);
    const fixture = Object.values(environment).some((v) =>
      String(v).includes('TEST-FIXTURE'),
    );
    if (
      !fixture &&
      (!/950\s*PR/iu.test(String(environment.device)) ||
        !/\b9\.1\.0\b/u.test(String(environment.cann)))
    )
      throw new Error(
        'Observed SDK environment does not match 950PR / CANN 9.1.0',
      );
    return {
      ready: !fixture,
      status: fixture ? 'test-fixture' : 'passed',
      evaluationRuns,
      runId: result.runId,
      cleanup: result.cleanup,
      environment,
      resultPath,
      error: null,
    };
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 4000);
    if (native === null)
      await writeFile(resultPath, JSON.stringify({ error: message }) + '\n');
    return {
      ready: false,
      status: signal.aborted ? 'cancelled' : 'failed',
      evaluationRuns,
      runId: result?.runId ?? null,
      cleanup:
        evaluationRuns === 0 ? 'not-started' : (result?.cleanup ?? 'unknown'),
      environment: result?.assessment?.environment ?? null,
      resultPath,
      error: message,
    };
  }
}
