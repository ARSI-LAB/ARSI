import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ApplicationInput,
  ApplicationOutput,
  RuntimeContext,
  JsonObject,
  JsonValue,
  Operation,
  OperationDefinition,
} from '../../contracts/index.js';
import {
  createFileApplication,
  readInstance,
} from '../shared/file-application/files.js';
import { safePath } from '../shared/file-application/target.js';
import { digest, object, string, unknownKeys } from '../../shared/json.js';
import { InferenceStartupError } from '../../shared/errors.js';
import { createRemoteBackend } from './remote.js';
import type { InferenceConfig } from './schema.js';
interface OwnedProcess {
  child: ChildProcess;
  exited: Promise<void>;
}
const processFacts = 'application-inference-processes';
async function readProcess(
  services: RuntimeContext,
  instanceId: string,
): Promise<JsonObject | null> {
  try {
    return await services.facts.read(processFacts, instanceId);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No TCP port allocated');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
function positive(
  value: JsonValue | undefined,
  fallback: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (
    typeof result !== 'number' ||
    !Number.isSafeInteger(result) ||
    result <= 0
  )
    throw new Error(`${label}: expected positive integer`);
  return result;
}
async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ESRCH'
    )
      return false;
    throw error;
  }
}
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
  } catch (error) {
    if (
      !(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ESRCH'
      )
    )
      throw error;
  }
}
export const createApplicationInference: OperationDefinition<
  ApplicationInput,
  ApplicationOutput,
  InferenceConfig
>['create'] = async (
  config,
  services,
): Promise<Operation<ApplicationInput, ApplicationOutput>> => {
  if ('remote' in config) {
    if ('start' in config && config.start !== undefined)
      throw new Error('remote and start are mutually exclusive');
    const backend = await createRemoteBackend(config, services);
    const application = await createFileApplication(config, services, backend);
    const resumed = new Map<string, RuntimeContext>();
    return {
      ...application,
      async execute(input, context): Promise<ApplicationOutput> {
        if (input.action === 'acquire') {
          const instance = await readInstance(services, input.instanceId);
          if (instance?.status === 'ready') {
            if (
              instance.experimentId !== context.experimentId ||
              instance.candidateRef !== input.candidateRef
            )
              throw new Error('instance identity conflict');
            await backend.validateInstance(instance, context);
            resumed.set(input.instanceId, context);
          }
        }
        const result = await application.execute(input, context);
        if (input.action === 'release') resumed.delete(input.instanceId);
        return result;
      },
      async dispose(): Promise<void> {
        const results = await Promise.allSettled(
          [...resumed].map(async ([instanceId, context]) => {
            await application.execute(
              { action: 'release', instanceId },
              context.extend({ signal: context.cleanup }),
            );
            resumed.delete(instanceId);
          }),
        );
        await application.dispose();
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      },
    };
  }
  const start = config.start,
    endpoint = config.endpoint,
    health = config.healthcheck ?? {},
    shutdown = config.shutdown ?? {},
    resources = config.resources ?? {},
    credentials = config.credentials ?? {};
  const owned = new Map<string, OwnedProcess>();
  const leases = new Set<string>();
  const lock = join(
    services.dataDirectory,
    'application-inference',
    'service-locks',
    digest(resources),
  );
  const grace = positive(
    shutdown.gracePeriodMs,
    10000,
    'shutdown.gracePeriodMs',
  );
  const stop = async (
    instance: JsonObject,
    context: Pick<RuntimeContext, 'signal'>,
  ): Promise<void> => {
    const instanceId = string(instance.instanceId);
    const running = owned.get(instanceId);
    if (running) {
      killGroup(running.child, 'SIGTERM');
      const retired = await Promise.race([
        running.exited.then(() => true),
        delay(grace, false, { signal: context.signal }),
      ]);
      if (!retired) {
        killGroup(running.child, 'SIGKILL');
        await running.exited;
      } else if (
        running.child.pid &&
        process.platform !== 'win32' &&
        (await alive(-running.child.pid))
      ) {
        // A child can exit before its descendants. Retire the entire owned group.
        await delay(grace, undefined, { signal: context.signal });
        killGroup(running.child, 'SIGKILL');
      }
      owned.delete(instanceId);
    }
    const saved = await readProcess(services, instanceId);
    if (!leases.has(instanceId) && (!saved || saved.status === 'stopped'))
      return;
    if (
      !leases.has(instanceId) &&
      saved &&
      (typeof saved.pid !== 'number' || (await alive(saved.pid)))
    )
      throw new Error(
        'Service process outcome unknown after restart; reconciliation must confirm ownership before stopping',
      );
    if (saved && typeof saved.lockDirectory === 'string') {
      if (saved.lockDirectory !== lock)
        throw new Error('Service lock identity mismatch');
      let holder: JsonObject | null;
      try {
        holder = object(
          JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')),
        );
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
        holder = null;
      }
      if (holder) {
        if (holder.instanceId !== instanceId)
          throw new Error('Service lock owner mismatch');
        await rm(lock, { recursive: true, force: true });
      }
    }
    leases.delete(instanceId);
    await services.facts.write(processFacts, instanceId, {
      ...saved,
      instanceId,
      status: 'stopped',
      pid: null,
      lockDirectory: null,
    });
  };
  return createFileApplication(config, services, {
    capability: 'inference-endpoint',
    async verify(_directory, context): Promise<JsonObject> {
      context.signal.throwIfAborted();
      return {};
    },
    async acquire(
      directory,
      _identity,
      instanceId,
      context,
    ): Promise<JsonObject> {
      await mkdir(join(lock, '..'), { recursive: true });
      try {
        await mkdir(lock);
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'EEXIST'
        )
          throw new Error(
            'Inference resources are already leased by another instance',
          );
        throw error;
      }
      try {
        await writeFile(
          join(lock, 'owner.json'),
          JSON.stringify({ instanceId, experimentId: context.experimentId }),
        );
        await services.facts.write(processFacts, instanceId, {
          instanceId,
          experimentId: context.experimentId,
          status: 'starting',
          pid: null,
          lockDirectory: lock,
        });
      } catch (error) {
        await rm(lock, { recursive: true, force: true });
        throw error;
      }
      leases.add(instanceId);
      const allocated = await port();
      const expand = (value: JsonValue): string => {
        if (typeof value === 'string') return value;
        const token = object(value, 'argv token');
        unknownKeys(token, ['resource', 'path'], 'argv token');
        const name = string(token.resource);
        let result: string;
        if (name === 'workspace') result = directory;
        else if (name === 'port') result = String(allocated);
        else result = string(resources[name], `resources.${name}`);
        return token.path === undefined
          ? result
          : join(result, safePath(token.path));
      };
      if (!Array.isArray(start.argv) || !start.argv.length)
        throw new Error('start.argv is required');
      const argv = start.argv.map(expand),
        command = string(argv[0]);
      const cwd =
        start.cwd === undefined
          ? directory
          : resolve(directory, safePath(start.cwd));
      const child = spawn(command, argv.slice(1), {
        cwd,
        env: process.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const spawnState: { error: Error | null } = { error: null };
      for (const stream of [child.stdout, child.stderr]) stream?.resume();
      const exited = new Promise<void>((resolve) => {
        child.once('error', (error) => {
          spawnState.error = error;
          resolve();
        });
        child.once('exit', () => resolve());
      });
      owned.set(instanceId, { child, exited });
      await services.facts.write(processFacts, instanceId, {
        instanceId,
        experimentId: context.experimentId,
        status: 'running',
        pid: child.pid ?? null,
        lockDirectory: lock,
        commandDigest: digest(argv),
      });
      const origin = `http://127.0.0.1:${allocated}`,
        path = typeof health.path === 'string' ? health.path : '/health';
      if (!path.startsWith('/') || path.startsWith('//'))
        throw new Error('healthcheck.path must be a local absolute path');
      const deadline =
        health.timeoutMs === undefined
          ? undefined
          : Date.now() + positive(health.timeoutMs, 0, 'healthcheck.timeoutMs');
      const interval = positive(
        health.intervalMs,
        250,
        'healthcheck.intervalMs',
      );
      while (true) {
        context.signal.throwIfAborted();
        if (spawnState.error)
          throw new Error('Could not spawn inference service', {
            cause: spawnState.error,
          });
        if (child.exitCode !== null || child.signalCode !== null)
          throw new InferenceStartupError(
            `Inference service exited before readiness: ${child.exitCode ?? child.signalCode}`,
          );
        if (deadline !== undefined && Date.now() >= deadline)
          throw new InferenceStartupError(
            'Inference service readiness timeout',
          );
        try {
          const response = await fetch(origin + path, {
            signal: AbortSignal.any([
              context.signal,
              AbortSignal.timeout(
                deadline === undefined
                  ? 5000
                  : Math.min(5000, Math.max(1, deadline - Date.now())),
              ),
            ]),
          });
          await response.body?.cancel();
          if (response.ok) break;
        } catch (error) {
          if (context.signal.aborted) throw error;
        }
        await delay(interval, undefined, { signal: context.signal });
      }
      const basePath =
        typeof endpoint.basePath === 'string' ? endpoint.basePath : '/v1';
      if (!basePath.startsWith('/') || basePath.startsWith('//'))
        throw new Error('endpoint.basePath must be a local absolute path');
      return {
        kind: 'inference-endpoint',
        instanceId,
        baseUrl: origin + basePath,
        model: string(endpoint.model),
        resources,
        credentialRef: credentials.apiKeyEnv ?? null,
      };
    },
    release: stop,
    async dispose(): Promise<void> {
      for (const instanceId of leases) {
        const running = owned.get(instanceId);
        if (running) {
          killGroup(running.child, 'SIGKILL');
          await running.exited;
          owned.delete(instanceId);
        }
        await stop(
          { instanceId },
          { signal: AbortSignal.timeout(grace + 1000) },
        );
      }
    },
  });
};
