import { execFile, spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { RuntimeContext, JsonObject } from '../../contracts/index.js';
import type { ApplicationBackend } from '../shared/file-application/files.js';
import { safePath, scanTree } from '../shared/file-application/target.js';
import { digest, object, string } from '../../shared/json.js';
import { InferenceStartupError } from '../../shared/errors.js';

const namespace = 'application-inference-remote';
interface RemoteBackend extends ApplicationBackend {
  validateInstance(
    instance: JsonObject,
    context: RuntimeContext,
  ): Promise<void>;
}
async function fact(
  services: RuntimeContext,
  key: string,
): Promise<JsonObject | null> {
  try {
    return await services.facts.read(namespace, key);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}
function positive(value: unknown, fallback: number, field: string): number {
  const result = value ?? fallback;
  if (
    typeof result !== 'number' ||
    !Number.isSafeInteger(result) ||
    result <= 0
  )
    throw new Error(`${field}: expected positive integer`);
  return result;
}
function ratio(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 1
  )
    throw new Error(`${field}: expected number in (0, 1]`);
  return value;
}
function endpointOrigin(raw: unknown): string {
  const value = string(raw, 'endpoint.origin');
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('endpoint.origin must be a credential-free HTTP(S) origin');
  return url.origin;
}
function path(raw: unknown, fallback: string, field: string): string {
  const value = raw === undefined ? fallback : string(raw, field);
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('?') ||
    value.includes('#')
  )
    throw new Error(`${field}: expected absolute URL path`);
  return value;
}

/** A script request is a bounded command, never the lifetime owner of the remote server. */
async function command(
  executable: string,
  script: string,
  request: JsonObject,
  signal: AbortSignal,
): Promise<JsonObject> {
  signal.throwIfAborted();
  return new Promise<JsonObject>((resolveResult, reject) => {
    const child = spawn(executable, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const kill = (): void => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () =>
          child.kill(),
        );
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              'code' in error &&
              error.code === 'ESRCH'
            )
          )
            reject(error);
        }
      }
    };
    signal.addEventListener('abort', kill, { once: true });
    if (signal.aborted) kill();
    let output = '';
    let exceeded = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (output.length + chunk.length > 1024 * 1024) {
        exceeded = true;
        kill();
      } else output += chunk;
    });
    // Script diagnostics may contain deployment credentials; do not relay them.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('close', (code) => {
      signal.removeEventListener('abort', kill);
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      if (exceeded) {
        reject(new Error('Remote lifecycle response exceeded 1 MiB'));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Remote lifecycle ${String(request.action)} command failed (${code}); reconcile remote ownership before retrying`,
          ),
        );
        return;
      }
      try {
        resolveResult(object(JSON.parse(output), 'remote lifecycle response'));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function assertIdentity(response: JsonObject, request: JsonObject): void {
  if (response.instanceId !== request.instanceId)
    throw new Error('Remote instance ownership mismatch');
  if (
    response.status !== 'stopped' &&
    response.parametersDigest !== request.parametersDigest
  )
    throw new Error('Remote parameter identity mismatch');
}
function checkStartupRejection(response: JsonObject): void {
  if (response.status !== 'startup-failed') return;
  const reason =
    typeof response.reason === 'string' && response.reason.trim()
      ? `: ${response.reason}`
      : '';
  throw new InferenceStartupError(`Remote inference startup failed${reason}`);
}
function verifiedResources(response: JsonObject): JsonObject {
  const resources = object(response.resources, 'remote resources');
  if (
    resources.verified !== true ||
    !Array.isArray(resources.devices) ||
    !resources.devices.length ||
    resources.devices.some((value) => typeof value !== 'string' || !value)
  )
    throw new Error('Remote lifecycle must report verified device identity');
  for (const field of ['host', 'modelIdentity', 'software'])
    string(resources[field], `remote resources.${field}`);
  // Only invariant, queried identity participates in cross-candidate comparisons.
  return {
    verified: true,
    host: resources.host,
    modelIdentity: resources.modelIdentity,
    software: resources.software,
    devices: resources.devices,
  };
}

export async function createRemoteBackend(
  config: JsonObject,
  services: RuntimeContext,
): Promise<RemoteBackend> {
  const remote = object(config.remote);
  const endpoint = object(config.endpoint);
  const health = object(config.healthcheck ?? {});
  const origin = endpointOrigin(endpoint.origin);
  const basePath = path(endpoint.basePath, '/v1', 'endpoint.basePath');
  const healthPath = path(health.path, '/health', 'healthcheck.path');
  const script = resolve(services.rootDirectory, string(remote.script));
  const executable =
    remote.executable === undefined ? 'python3' : string(remote.executable);
  const scriptDigest = digest(await readFile(script, 'utf8'));
  const workspaceMode = remote.parametersFile === null;
  const parametersFile = workspaceMode
    ? null
    : safePath(remote.parametersFile ?? 'tuning.json');
  const timeout =
    remote.timeoutMs === undefined
      ? undefined
      : positive(remote.timeoutMs, 0, 'remote.timeoutMs');
  const readinessTimeout =
    health.timeoutMs === undefined
      ? timeout
      : positive(health.timeoutMs, 0, 'healthcheck.timeoutMs');
  const interval = positive(health.intervalMs, 250, 'healthcheck.intervalMs');
  const cleanupTimeout = positive(
    object(config.shutdown ?? {}).gracePeriodMs,
    10000,
    'shutdown.gracePeriodMs',
  );
  const lock = join(
    services.dataDirectory,
    'application-inference',
    'remote-locks',
    digest({ origin }),
  );
  const active = new Set<string>();
  const calibration =
    remote.calibration === undefined ? null : object(remote.calibration);
  const discoverParameters = remote.discoverParameters === true;
  const tuneMemory = discoverParameters && !calibration;
  let calibrationSweep: { start: number; step: number; steps: number } | null =
    null;
  if (calibration) {
    const start = ratio(calibration.start, 'remote.calibration.start');
    const min = ratio(calibration.min, 'remote.calibration.min');
    const step = ratio(calibration.step, 'remote.calibration.step');
    const steps = Math.floor((start - min + 1e-12) / step);
    if (
      min > start ||
      !Number.isSafeInteger(steps) ||
      (steps > 0 && step < 1e-12)
    )
      throw new Error(
        'remote.calibration: invalid search range or step precision',
      );
    positive(calibration.maxNumSeqs, 1, 'remote.calibration.maxNumSeqs');
    positive(
      calibration.maxNumBatchedTokens,
      1,
      'remote.calibration.maxNumBatchedTokens',
    );
    calibrationSweep = { start, step, steps };
  }
  const invoke = async (
    request: JsonObject,
    signal: AbortSignal,
  ): Promise<JsonObject> => {
    const response = await command(
      executable,
      script,
      request,
      timeout === undefined
        ? signal
        : AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    );
    assertIdentity(response, request);
    return response;
  };
  const waitReady = async (
    request: JsonObject,
    context: Pick<RuntimeContext, 'signal'>,
  ): Promise<JsonObject> => {
    const signal =
      readinessTimeout === undefined
        ? context.signal
        : AbortSignal.any([
            context.signal,
            AbortSignal.timeout(readinessTimeout),
          ]);
    while (true) {
      signal.throwIfAborted();
      const status = await invoke({ ...request, action: 'status' }, signal);
      if (
        status.status === 'capacity-rejected' ||
        status.status === 'startup-failed'
      )
        return status;
      if (status.status !== 'starting' && status.status !== 'ready')
        throw new Error(
          `Remote service did not become ready: ${String(status.status)}`,
        );
      if (status.status === 'ready') {
        verifiedResources(status);
        try {
          const response = await fetch(origin + healthPath, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          });
          await response.body?.cancel();
          if (response.ok) return status;
        } catch (error) {
          if (signal.aborted) throw error;
        }
      }
      await delay(interval, undefined, { signal });
    }
  };
  const stopRemote = async (
    request: JsonObject,
    signal: AbortSignal,
  ): Promise<void> => {
    const response = await invoke({ ...request, action: 'stop' }, signal);
    if (response.status !== 'stopped')
      throw new Error('Remote service stop outcome is unknown');
  };
  const release = async (
    instance: JsonObject,
    context: Pick<RuntimeContext, 'signal'> &
      Partial<Pick<RuntimeContext, 'experimentId'>>,
  ): Promise<void> => {
    const instanceId = string(instance.instanceId);
    const saved = await fact(services, instanceId);
    let holder: JsonObject | null;
    try {
      holder = object(
        JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')),
      );
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
      holder = null;
    }
    if (!holder || holder.instanceId !== instanceId) {
      if (saved && saved.status !== 'stopped')
        throw new Error('Remote service lock owner mismatch');
      active.delete(instanceId);
      return;
    }
    if (saved && saved.status !== 'stopped' && saved.lockDirectory !== lock)
      throw new Error('Remote service lock identity mismatch');
    const request = object(
      saved ? saved.request : holder.request,
      'remote cleanup request',
    );
    const experimentId =
      context.experimentId ?? instance.experimentId ?? request.experimentId;
    if (
      holder.experimentId !== experimentId ||
      request.experimentId !== experimentId
    )
      throw new Error('Remote service lock owner mismatch');
    if (!saved && request.instanceId !== instanceId)
      throw new Error(
        'Remote ownership intent does not match the cleanup request',
      );
    if (!saved || saved.status !== 'stopped') {
      // A published ownership intent precedes the first private fact. Confirm stop
      // using that intent if interruption occurred before the fact was written.
      await stopRemote(
        request,
        AbortSignal.any([context.signal, AbortSignal.timeout(cleanupTimeout)]),
      );
      await services.facts.write(namespace, instanceId, {
        ...saved,
        request,
        status: 'stopped',
        lockDirectory: null,
      });
    }
    // A stopped fact can survive an interrupted unlink. Retry the owned unlink;
    // never leave the lease permanently held merely because remote stop succeeded.
    await rm(lock, { recursive: true, force: true });
    active.delete(instanceId);
  };
  const verify: ApplicationBackend['verify'] = async (
    directory,
    context,
  ): Promise<JsonObject> => {
    context.signal.throwIfAborted();
    if (parametersFile === null) {
      const workspace = Object.fromEntries(
        Object.entries(await scanTree(directory)).map(([path, file]) => [
          path,
          { content: file.content, mode: file.mode },
        ]),
      );
      return { parameters: {}, workspace, parametersDigest: digest(workspace) };
    }
    const parameters = object(
      JSON.parse(await readFile(join(directory, parametersFile), 'utf8')),
      'engine parameters',
    );
    if (!Object.keys(parameters).length)
      throw new Error('Engine parameters must not be empty');
    for (const key of Object.keys(parameters)) {
      if (!/^[a-z][a-z0-9_]*$/.test(key))
        throw new Error(
          `Engine parameter ${key} must be a lowercase argument name`,
        );
      if (
        (key === 'gpu_memory_utilization' && !tuneMemory) ||
        (key === 'enable_prefix_caching' && !discoverParameters) ||
        [
          'host',
          'port',
          'tensor_parallel_size',
          'max_model_len',
          'served_model_name',
          'dtype',
        ].includes(key)
      )
        throw new Error(
          `Engine parameter ${key} is owned by deployment or calibration`,
        );
    }
    if (parameters.gpu_memory_utilization !== undefined)
      ratio(parameters.gpu_memory_utilization, 'gpu_memory_utilization');
    return { parameters, parametersDigest: digest(parameters) };
  };
  const comparableResources = (
    resources: JsonObject,
    utilization: number,
  ): JsonObject => ({
    ...resources,
    ...(tuneMemory || workspaceMode
      ? {}
      : { gpuMemoryUtilization: utilization }),
  });
  return {
    capability: 'inference-endpoint',
    ...(!workspaceMode &&
      discoverParameters && {
        async describeTarget(context: RuntimeContext): Promise<JsonObject> {
          const signal =
            timeout === undefined
              ? context.signal
              : AbortSignal.any([context.signal, AbortSignal.timeout(timeout)]);
          const response = await command(
            executable,
            script,
            { action: 'describe-parameters' },
            signal,
          );
          const parameterCatalog = object(
            response.parameters,
            'installed engine parameters',
          );
          if (!tuneMemory) delete parameterCatalog.gpu_memory_utilization;
          if (!Object.keys(parameterCatalog).length)
            throw new Error(
              'The inference launcher did not discover any tunable parameters',
            );
          return { parameterCatalog };
        },
      }),
    verify,
    release,
    async validateInstance(instance, context): Promise<void> {
      const instanceId = string(instance.instanceId);
      const saved = await fact(services, instanceId);
      if (!saved || saved.status !== 'running')
        throw new Error('Remote instance requires reconciliation before reuse');
      const request = object(saved.request);
      const ready = await waitReady(request, context);
      if (ready.status !== 'ready')
        throw new Error('Remote instance is no longer ready');
      const expected = object(object(instance.execution).resources);
      const actual = comparableResources(
        verifiedResources(ready),
        ratio(request.memoryUtilization, 'saved memoryUtilization'),
      );
      if (digest(expected) !== digest(actual))
        throw new Error(
          'Remote device/model/software identity changed before reuse',
        );
      active.add(instanceId);
    },
    async acquire(
      _directory,
      identity,
      instanceId,
      context,
    ): Promise<JsonObject> {
      const parameters = object(identity.parameters);
      let utilization = ratio(
        parameters.gpu_memory_utilization ?? remote.memoryUtilization ?? 0.9,
        'memoryUtilization',
      );
      let request: JsonObject = {
        instanceId,
        experimentId: context.experimentId,
        parameters,
        parametersDigest: identity.parametersDigest,
        ...(identity.workspace === undefined
          ? {}
          : { workspace: identity.workspace }),
        memoryUtilization: utilization,
        endpoint: { origin, model: string(endpoint.model) },
      };
      const persist = async (): Promise<void> => {
        await services.facts.write(namespace, instanceId, {
          status: 'starting',
          lockDirectory: lock,
          request,
        });
      };
      await mkdir(join(lock, '..'), { recursive: true });
      const pending = await mkdtemp(join(lock, '..', '.pending-'));
      let claimed = false;
      try {
        // Publish a complete owner atomically; a crash while writing the owner
        // leaves only an unpublished temporary directory, never an ownerless lease.
        await writeFile(
          join(pending, 'owner.json'),
          JSON.stringify({
            instanceId,
            experimentId: context.experimentId,
            request,
          }),
        );
        try {
          await rename(pending, lock);
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(error.code))
          ) {
            throw new Error(
              'Remote inference resources are already leased by another instance',
              { cause: error },
            );
          }
          throw error;
        }
        claimed = true;
        await persist();
      } catch (error) {
        if (claimed) await rm(lock, { recursive: true, force: true });
        throw error;
      } finally {
        if (!claimed) await rm(pending, { recursive: true, force: true });
      }
      active.add(instanceId);
      const start = async (): Promise<JsonObject> => {
        const previous = await invoke(
          { ...request, action: 'status' },
          context.signal,
        );
        if (previous.status === 'stopped') {
          const started = await invoke(
            { ...request, action: 'start' },
            context.signal,
          );
          if (
            started.status === 'capacity-rejected' ||
            started.status === 'startup-failed'
          )
            return started;
          if (!['ready', 'starting'].includes(String(started.status)))
            throw new Error(`Remote start failed: ${String(started.status)}`);
        } else if (!['ready', 'starting'].includes(String(previous.status)))
          throw new Error(
            `Remote state requires reconciliation: ${String(previous.status)}`,
          );
        return waitReady(request, context);
      };
      const calibrationKey = `calibration-${digest({ experimentId: context.experimentId, origin, scriptDigest, calibration })}`;
      const previousCalibration = calibration
        ? await fact(services, calibrationKey)
        : null;
      if (calibration && calibrationSweep && !previousCalibration) {
        let selected: JsonObject | null = null;
        const { start: initial, step, steps } = calibrationSweep;
        for (let index = 0; index <= steps; index++) {
          context.signal.throwIfAborted();
          const value = Number((initial - step * index).toFixed(12));
          const probeParameters = {
            ...parameters,
            max_num_seqs: calibration.maxNumSeqs,
            max_num_batched_tokens: calibration.maxNumBatchedTokens,
          };
          request = {
            ...request,
            instanceId: `${instanceId}-calibration`,
            parameters: probeParameters,
            parametersDigest: digest(probeParameters),
            memoryUtilization: value,
          };
          await persist();
          const result = await start();
          checkStartupRejection(result);
          await stopRemote(request, AbortSignal.timeout(cleanupTimeout));
          if (result.status === 'ready') {
            selected = {
              memoryUtilization: value,
              resources: verifiedResources(result),
            };
            break;
          }
        }
        if (!selected)
          throw new InferenceStartupError(
            'No memory utilization passed remote calibration',
          );
        await services.facts.write(namespace, calibrationKey, selected);
      }
      const calibrated = calibration
        ? await fact(services, calibrationKey)
        : null;
      if (calibrated)
        utilization = ratio(
          calibrated.memoryUtilization,
          'saved calibration.memoryUtilization',
        );
      request = {
        ...request,
        instanceId,
        parameters,
        parametersDigest: identity.parametersDigest,
        ...(identity.workspace === undefined
          ? {}
          : { workspace: identity.workspace }),
        memoryUtilization: utilization,
      };
      await persist();
      const ready = await start();
      checkStartupRejection(ready);
      if (ready.status !== 'ready')
        throw new InferenceStartupError(
          'Remote candidate exceeded calibrated memory capacity',
        );
      const resources = verifiedResources(ready);
      if (calibrated && digest(resources) !== digest(calibrated.resources))
        throw new Error(
          'Remote device/model/software identity differs from calibration',
        );
      await services.facts.write(namespace, instanceId, {
        status: 'running',
        lockDirectory: lock,
        request,
      });
      return {
        kind: 'inference-endpoint',
        instanceId,
        baseUrl: origin + basePath,
        model: string(endpoint.model),
        resources: comparableResources(resources, utilization),
        ...(tuneMemory ? { gpuMemoryUtilization: utilization } : {}),
        parametersDigest: identity.parametersDigest,
        ...(identity.workspace === undefined
          ? {}
          : { workspace: identity.workspace }),
        credentialRef: object(config.credentials ?? {}).apiKeyEnv ?? null,
      };
    },
    async dispose(): Promise<void> {
      for (const instanceId of [...active])
        await release(
          { instanceId },
          { signal: AbortSignal.timeout(cleanupTimeout) },
        );
    },
  };
}
