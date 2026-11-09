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
import type {
  ApplicationInput,
  ApplicationOutput,
  Operation,
  RuntimeContext,
  JsonObject,
} from '../../../contracts/index.js';
import {
  createFileApplication,
  readInstance,
  type ApplicationBackend,
  type FileApplicationConfig,
} from '../file-application/files.js';
import { safePath } from '../file-application/target.js';
import { digest, object, string } from '../../../shared/json.js';

/**
 * Backend for Applications whose instances are driven by one lifecycle script
 * speaking the one-shot JSON stdin/stdout protocol (start/status/stop). The
 * script owns the target machine (remote NPU host or local toolchain); the
 * backend owns leases, identity assertions, readiness polling, and explicit
 * failure semantics. Behavior and message shapes are shared; only labels,
 * namespaces, and the default parameters file differ per Application.
 */

export type ScriptedLifecycleOptions = {
  /** Facts namespace for per-instance bookkeeping. */
  namespace: string;
  /** Capability reported to acquire; evaluators select instances by it. */
  capability: string;
  /** Error-message subject, e.g. 'Remote operator'. */
  subject: string;
  /** Label for protocol-level failures, e.g. 'Remote lifecycle'. */
  lifecycleLabel: string;
  /** Label for capacity rejections, e.g. 'Remote NPU capacity'. */
  capacityLabel: string;
  /** Label of the instance resources object in validation errors. */
  resourcesLabel: string;
  /** Lease directory under the application data directory. */
  lockDirectory: string;
  /** Candidate JSON file the script reads parameters from. */
  defaultParametersFile: string;
  /** Parameter labels for verify() diagnostics. */
  parametersLabel: string;
  parameterLabel: string;
  /** Key of the lifecycle section in the plugin config ('remote' or 'lifecycle'). */
  configSection: string;
};

export type ScriptedLifecycle = {
  script: string;
  executable?: string;
  parametersFile?: string;
  timeoutMs?: number;
};

export type ScriptedBackend = ApplicationBackend & {
  validateInstance(
    instance: JsonObject,
    context: RuntimeContext,
  ): Promise<void>;
};

async function fact(
  services: RuntimeContext,
  namespace: string,
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

/** A script request is a bounded command, never the lifetime owner of the instance. */
export async function command(
  label: string,
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
    // Script diagnostics may contain host credentials; do not relay them.
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
        reject(new Error(`${label} response exceeded 1 MiB`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `${label} ${String(request.action)} command failed (${code}); reconcile instance ownership before retrying`,
          ),
        );
        return;
      }
      try {
        resolveResult(
          object(JSON.parse(output), `${label.toLowerCase()} response`),
        );
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function assertIdentity(
  response: JsonObject,
  request: JsonObject,
): void {
  if (response.instanceId !== request.instanceId)
    throw new Error('Instance ownership mismatch');
  if (
    response.status !== 'stopped' &&
    response.parametersDigest !== request.parametersDigest
  )
    throw new Error('Parameter identity mismatch');
}

export function verifiedResources(
  options: ScriptedLifecycleOptions,
  response: JsonObject,
): JsonObject {
  const resources = object(response.resources, `${options.resourcesLabel}`);
  if (
    resources.verified !== true ||
    !Array.isArray(resources.devices) ||
    !resources.devices.length ||
    resources.devices.some((value) => typeof value !== 'string' || !value)
  )
    throw new Error(
      `${options.lifecycleLabel} must report verified device identity`,
    );
  for (const field of ['host', 'modelIdentity', 'software'])
    string(resources[field], `${options.resourcesLabel}.${field}`);
  // Only invariant, queried identity participates in cross-candidate comparisons.
  return {
    verified: true,
    host: resources.host,
    modelIdentity: resources.modelIdentity,
    software: resources.software,
    devices: resources.devices,
  };
}

/** Build failures carry a diagnostic and log path so they can feed back to proposers. */
export function failureDetail(
  options: ScriptedLifecycleOptions,
  response: JsonObject,
): string {
  if (response.failure === undefined) return '';
  const detail = object(
    response.failure,
    `${options.resourcesLabel} failure detail`,
  );
  const message = string(
    detail.message,
    `${options.resourcesLabel} failure message`,
  );
  const logPath =
    detail.logPath === undefined
      ? ''
      : `; log: ${string(detail.logPath, `${options.resourcesLabel} failure logPath`)}`;
  return `: ${message}${logPath}`;
}

export function createScriptedLifecycleBackend(
  options: ScriptedLifecycleOptions,
  lifecycle: ScriptedLifecycle,
  health: { intervalMs?: number; timeoutMs?: number },
  shutdown: { gracePeriodMs?: number },
  services: RuntimeContext,
): ScriptedBackend {
  const script = resolve(services.rootDirectory, lifecycle.script);
  const executable =
    lifecycle.executable === undefined
      ? 'python3'
      : string(lifecycle.executable);
  const parametersFile = safePath(
    lifecycle.parametersFile ?? options.defaultParametersFile,
  );
  const timeout = positive(lifecycle.timeoutMs, 1800000, 'lifecycle.timeoutMs');
  const readinessTimeout = positive(
    health.timeoutMs,
    timeout,
    'healthcheck.timeoutMs',
  );
  const interval = positive(health.intervalMs, 1000, 'healthcheck.intervalMs');
  const cleanupTimeout = positive(
    shutdown.gracePeriodMs,
    60000,
    'shutdown.gracePeriodMs',
  );
  // The target machine and its build toolchain are the shared resource the
  // lease protects; the script is their standing proxy on this host.
  const lock = join(
    services.dataDirectory,
    options.lockDirectory,
    digest({ script }),
  );
  const active = new Set<string>();
  const invoke = async (
    request: JsonObject,
    signal: AbortSignal,
  ): Promise<JsonObject> => {
    const response = await command(
      options.lifecycleLabel,
      executable,
      script,
      request,
      AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    );
    assertIdentity(response, request);
    return response;
  };
  const waitReady = async (
    request: JsonObject,
    context: Pick<RuntimeContext, 'signal'>,
  ): Promise<JsonObject> => {
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(readinessTimeout),
    ]);
    while (true) {
      signal.throwIfAborted();
      const status = await invoke({ ...request, action: 'status' }, signal);
      if (status.status === 'ready') {
        verifiedResources(options, status);
        return status;
      }
      if (status.status === 'rejected') return status;
      if (status.status === 'capacity-rejected' || status.status === 'failed')
        throw new Error(
          `${options.subject} instance did not become ready (${String(status.status)}${failureDetail(options, status)})`,
        );
      if (status.status !== 'starting')
        throw new Error(
          `${options.subject} instance requires reconciliation: ${String(status.status)}`,
        );
      await delay(interval, undefined, { signal });
    }
  };
  const stopInstance = async (
    request: JsonObject,
    signal: AbortSignal,
  ): Promise<void> => {
    const response = await invoke({ ...request, action: 'stop' }, signal);
    if (response.status !== 'stopped')
      throw new Error(`${options.subject} instance stop outcome is unknown`);
  };
  const release = async (
    instance: JsonObject,
    context: Pick<RuntimeContext, 'signal'> &
      Partial<Pick<RuntimeContext, 'experimentId'>>,
  ): Promise<void> => {
    const instanceId = string(instance.instanceId);
    const saved = await fact(services, options.namespace, instanceId);
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
        throw new Error(`${options.subject} instance lock owner mismatch`);
      active.delete(instanceId);
      return;
    }
    if (saved && saved.status !== 'stopped' && saved.lockDirectory !== lock)
      throw new Error(`${options.subject} instance lock identity mismatch`);
    const request = object(
      saved ? saved.request : holder.request,
      `${options.resourcesLabel} cleanup request`,
    );
    const experimentId =
      context.experimentId ?? instance.experimentId ?? request.experimentId;
    if (
      holder.experimentId !== experimentId ||
      request.experimentId !== experimentId
    )
      throw new Error(`${options.subject} instance lock owner mismatch`);
    if (!saved && request.instanceId !== instanceId)
      throw new Error(
        `${options.subject} ownership intent does not match the cleanup request`,
      );
    if (!saved || saved.status !== 'stopped') {
      // A published ownership intent precedes the first private fact. Confirm stop
      // using that intent if interruption occurred before the fact was written.
      await stopInstance(request, AbortSignal.timeout(cleanupTimeout));
      await services.facts.write(options.namespace, instanceId, {
        ...saved,
        request,
        status: 'stopped',
        lockDirectory: null,
      });
    }
    // A stopped fact can survive an interrupted unlink. Retry the owned unlink;
    // never leave the lease permanently held merely because stop succeeded.
    await rm(lock, { recursive: true, force: true });
    active.delete(instanceId);
  };
  return {
    capability: options.capability,
    async validateInstance(instance, context): Promise<void> {
      const instanceId = string(instance.instanceId);
      const saved = await fact(services, options.namespace, instanceId);
      if (!saved || saved.status !== 'running')
        throw new Error(
          `${options.subject} instance requires reconciliation before reuse`,
        );
      const request = object(saved.request);
      const ready = await waitReady(request, context);
      const expected = object(object(instance.execution).resources);
      if (ready.status === 'rejected') {
        if (expected.verified !== false)
          throw new Error(
            `${options.subject} instance identity changed between acquire and reuse`,
          );
        return;
      }
      if (digest(expected) !== digest(verifiedResources(options, ready)))
        throw new Error(
          `${options.subject} device/software identity changed before reuse`,
        );
    },
    async verify(directory, context): Promise<JsonObject> {
      context.signal.throwIfAborted();
      const parameters = object(
        JSON.parse(await readFile(join(directory, parametersFile), 'utf8')),
        options.parametersLabel,
      );
      if (!Object.keys(parameters).length)
        throw new Error(`${options.parametersLabel} must not be empty`);
      for (const [key, value] of Object.entries(parameters)) {
        if (
          !/^[A-Za-z][A-Za-z0-9_]*$/.test(key) ||
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          !Number.isSafeInteger(value)
        )
          throw new Error(
            `${options.parameterLabel} ${key} must be a finite integer argument`,
          );
      }
      return { parameters, parametersDigest: digest(parameters) };
    },
    async acquire(
      directory,
      identity,
      instanceId,
      context,
    ): Promise<JsonObject> {
      const parameters = object(identity.parameters);
      const request: JsonObject = {
        instanceId,
        experimentId: context.experimentId,
        parameters,
        parametersDigest: identity.parametersDigest,
        // The candidate workspace holds the source plus parameters file the
        // script syncs to the target; the script runs on this host.
        source: directory,
      };
      const persist = async (): Promise<void> => {
        await services.facts.write(options.namespace, instanceId, {
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
              `${options.subject} build resources are already leased by another instance`,
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
      const previous = await invoke(
        { ...request, action: 'status' },
        context.signal,
      );
      // A candidate the deterministic precheck rejected is a business outcome,
      // not an instance failure: the workspace is staged and owned, so the
      // acquire succeeds with unverified resources; the evaluator consumes the
      // workspace and records the auditable failed measurement (the state
      // marker stays 'failed').
      const rejectedAcquire = async (
        response: JsonObject,
      ): Promise<JsonObject> => {
        await services.facts.write(options.namespace, instanceId, {
          status: 'running',
          lockDirectory: lock,
          request,
        });
        return {
          kind: options.capability,
          instanceId,
          resources: { verified: false },
          parametersDigest: identity.parametersDigest,
          rejection: response.failure ?? null,
        };
      };
      let ready: JsonObject;
      if (previous.status === 'stopped') {
        const started = await invoke(
          { ...request, action: 'start' },
          context.signal,
        );
        if (started.status === 'capacity-rejected')
          throw new Error(
            `${options.capacityLabel} rejected the candidate${failureDetail(options, started)}`,
          );
        if (started.status === 'failed')
          throw new Error(
            `${options.subject} start failed${failureDetail(options, started)}`,
          );
        if (started.status === 'rejected') return rejectedAcquire(started);
        if (!['ready', 'starting'].includes(String(started.status)))
          throw new Error(
            `${options.subject} start returned unexpected status: ${String(started.status)}`,
          );
        ready =
          started.status === 'ready'
            ? started
            : await waitReady(request, context);
      } else if (previous.status === 'rejected') {
        return rejectedAcquire(previous);
      } else if (previous.status === 'failed') {
        throw new Error(
          `${options.subject} state requires reconciliation: failed${failureDetail(options, previous)}`,
        );
      } else if (previous.status === 'capacity-rejected') {
        throw new Error(
          `${options.subject} state requires reconciliation: capacity-rejected`,
        );
      } else {
        ready = await waitReady(request, context);
      }
      const resources = verifiedResources(options, ready);
      await services.facts.write(options.namespace, instanceId, {
        status: 'running',
        lockDirectory: lock,
        request,
      });
      return {
        kind: options.capability,
        instanceId,
        resources,
        parametersDigest: identity.parametersDigest,
      };
    },
    release,
    async dispose(): Promise<void> {
      for (const instanceId of [...active])
        await release(
          { instanceId },
          { signal: AbortSignal.timeout(cleanupTimeout) },
        );
    },
  };
}

/** Full Application operation with instance-resume reconciliation for a scripted lifecycle. */
export async function createScriptedApplication(
  config: JsonObject,
  options: ScriptedLifecycleOptions,
  services: RuntimeContext,
): Promise<Operation<ApplicationInput, ApplicationOutput>> {
  const lifecycle = object(config[options.configSection]);
  const backend = createScriptedLifecycleBackend(
    options,
    {
      script: string(lifecycle.script),
      executable:
        lifecycle.executable === undefined
          ? undefined
          : string(lifecycle.executable),
      parametersFile:
        lifecycle.parametersFile === undefined
          ? undefined
          : string(lifecycle.parametersFile),
      timeoutMs:
        lifecycle.timeoutMs === undefined
          ? undefined
          : Number(lifecycle.timeoutMs),
    },
    object(config.healthcheck ?? {}),
    object(config.shutdown ?? {}),
    services,
  );
  return createScriptedApplicationWithBackend(config, backend, services);
}

/**
 * Instance-resume reconciliation over an externally built scripted backend.
 * Applications that must compose the scripted lifecycle with extra verify or
 * acquire behavior supply their own backend here.
 */
export async function createScriptedApplicationWithBackend(
  config: JsonObject,
  backend: ScriptedBackend,
  services: RuntimeContext,
): Promise<Operation<ApplicationInput, ApplicationOutput>> {
  const application = await createFileApplication(
    config as FileApplicationConfig,
    services,
    backend,
  );
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
            context.extend({ signal: AbortSignal.timeout(10000) }),
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
