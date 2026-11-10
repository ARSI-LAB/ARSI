import { randomUUID } from 'node:crypto';
import { lstat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  fingerprintConfig,
  HarborBenchmark,
  HarborPythonVerifier,
  HarborShellVerifier,
  loadConfig,
  parseHarborConfig,
  parsePythonVerifierConfig,
  PINNED_NODE_IMAGE,
  type LoadedConfig,
  type PreparedTask,
} from 'ember-evaluator';
import type { JsonObject, JsonValue } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { plain } from '../../plugins/shared/evaluator-adapter/data.js';
import { prepareEvaluationConfig as prepareAgentbench } from '../../plugins/evaluator-agentbench/service.js';
import { prepareEvaluationConfig as prepareInferencebench } from '../../plugins/evaluator-inferencebench/service.js';
import { prepareEvaluationConfig as prepareOperatorbench } from '../../plugins/evaluator-operatorbench/service.js';
import { loadOperatorTask } from '../../plugins/shared/operator-task.js';
import { runCommand } from './process.js';
import type { DoctorContext, DoctorScript } from './types.js';
import { checkDockerDiskCapacity } from './docker-disk.js';
import { dockerLayersAreLocal } from './docker-disk-probe.js';

type Command = typeof runCommand;

function taskIds(value: JsonValue): string[] {
  if (Array.isArray(value)) return value.flatMap(taskIds);
  if (value !== null && typeof value === 'object')
    return Object.entries(value).flatMap(([key, entry]) =>
      /taskIds$/i.test(key) && Array.isArray(entry)
        ? entry.filter((item): item is string => typeof item === 'string')
        : taskIds(entry),
    );
  return [];
}

function expand(value: string, field: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const resolved = process.env[name];
    if (!resolved?.trim())
      throw new Error(`${field}: missing environment variable ${name}`);
    return resolved;
  });
}

function bytes(value: string | undefined): number {
  if (value === undefined) return 0;
  const matched = /^([0-9.]+)([bkmg]?)(?:b)?$/i.exec(value);
  if (!matched) throw new Error(`Unsupported Docker memory unit: ${value}`);
  return (
    Number(matched[1]) *
    1024 ** Math.max(0, 'bkmg'.indexOf(matched[2].toLowerCase() || 'b'))
  );
}

async function loadSdkConfig(
  ctx: DoctorContext,
  config: unknown,
): Promise<LoadedConfig> {
  const path = join(ctx.directory, 'evaluator.json');
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  let networkConfigPath = process.env.EVALUATOR_NETWORK_CONFIG;
  if (!networkConfigPath) {
    const configured = join(homedir(), '.ember-evaluator', 'network.yaml');
    const exists = await lstat(configured).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return null;
      throw error;
    });
    networkConfigPath = exists
      ? configured
      : join(ctx.directory, 'network.yaml');
    if (!exists) await writeFile(networkConfigPath, '{}\n', { mode: 0o600 });
  }
  // Loading validates registered SDK plugin configuration; it does not create a run.
  // An absent SDK home configuration must not let its initializer write outside
  // probe storage. Existing network settings still receive normal validation.
  return loadConfig(path, {}, process.env, {
    allowMissingAuth: true,
    networkConfigPath,
  });
}

async function imageCached(
  ctx: DoctorContext,
  command: Command,
  executable: string,
  image: string,
  id: string,
  dependent: string[],
): Promise<boolean> {
  try {
    await command(executable, ['image', 'inspect', image], {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)]),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      /no such image|image .* not found/i.test(error.message)
    ) {
      ctx.unchecked(
        id,
        `Image is not cached in the selected Docker context: ${image}. No image was fetched.`,
      );
      ctx.missing({
        field: 'benchmark.images',
        kind: 'image',
        reference: image,
        checksNotRun: [id, ...dependent],
      });
      return false;
    }
    return ctx.check(id, async () => {
      throw error;
    });
  }
  return ctx.check(id, async () => {});
}

async function containerProbe(
  command: Command,
  executable: string,
  image: string,
  args: string[],
  script: string,
  signal: AbortSignal,
  input?: string,
): Promise<string> {
  const name = `rsi-doctor-${randomUUID()}`;
  try {
    const result = await command(
      executable,
      [
        'run',
        '--rm',
        '--pull=never',
        '--name',
        name,
        ...args,
        image,
        'node',
        '-e',
        script,
      ],
      { signal, input },
    );
    return result.stdout;
  } finally {
    // The launching command may have been interrupted before Docker replied.
    try {
      await command(executable, ['rm', '-f', name], {
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      if (!(error instanceof Error && /no such container/i.test(error.message)))
        throw new Error(
          `Doctor container cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
    }
  }
}

async function checkDocker(
  ctx: DoctorContext,
  command: Command,
  loaded: LoadedConfig | undefined,
  metadata: { tasks: PreparedTask[]; sourceDirectory?: string },
  servicesReady: boolean,
): Promise<void> {
  const environment = loaded?.experiment.environment;
  const rawEnvironment = ctx.binding.config.environment;
  const rawName =
    typeof rawEnvironment === 'string'
      ? rawEnvironment
      : plain(rawEnvironment).name;
  const selectedEnvironment =
    environment?.name ??
    rawName ??
    (['workbuddy', 'terminalbench', 'harbor'].includes(
      typeof ctx.binding.config.benchmark === 'string'
        ? ctx.binding.config.benchmark
        : String(plain(ctx.binding.config.benchmark).name),
    )
      ? 'docker'
      : undefined);
  if (selectedEnvironment !== 'docker' || loaded?.deployment) {
    ctx.unchecked(
      'environment-readiness',
      'No bundled readiness probe applies to the selected SDK environment.',
    );
    ctx.unchecked(
      'workspace-cache-mounts',
      'A local Docker mount probe does not apply to the selected execution environment.',
    );
    ctx.unchecked(
      'docker-disk-space',
      'Disk availability on the selected execution node is not probed by the local Docker checks.',
    );
    ctx.unchecked(
      'docker-disk-capacity',
      'Disk demand and availability for the selected execution node could not be compared.',
    );
    return;
  }
  const executable =
    typeof environment?.config.dockerExecutable === 'string'
      ? environment.config.dockerExecutable
      : 'docker';
  let memory = 0;
  let cpus = 0;
  let dockerInfo: JsonObject = {};
  const ready = await ctx.check('docker', async (signal) => {
    const result = await command(
      executable,
      ['info', '--format', '{{json .}}'],
      { signal },
    );
    const info = object(JSON.parse(result.stdout));
    dockerInfo = info;
    memory = Number(info.MemTotal);
    cpus = Number(info.NCPU);
    if (!(memory > 0 && cpus > 0))
      throw new Error('Docker did not report positive MemTotal and NCPU.');
  });
  if (!ready) {
    for (const id of [
      'docker-capacity',
      'docker-disk-space',
      'docker-disk-capacity',
      'task-images',
      'gateway-image-cache',
      'workspace-cache-mounts',
      'gateway-model-access',
    ])
      ctx.unchecked(id, 'Docker daemon readiness failed.');
    return;
  }
  if (metadata.tasks.length) {
    await ctx.check('docker-capacity', async () => {
      for (const task of metadata.tasks)
        for (const phase of task.steps?.map((step) => step.task) ?? [task])
          for (const required of [phase.solveEnv, phase.verifyEnv]) {
            if (!required) continue;
            if (
              (required.resources?.cpus ?? 0) > cpus ||
              bytes(required.resources?.memory) > memory
            )
              throw new Error(
                `Docker capacity cannot satisfy declared resources for ${task.input.id}.`,
              );
          }
    });
    const images = new Set<string>();
    let builds = false;
    for (const task of metadata.tasks)
      for (const phase of task.steps?.map((step) => step.task) ?? [task])
        for (const env of [phase.solveEnv, phase.verifyEnv]) {
          if (!env) continue;
          if (env.image) images.add(env.image);
          if (env.build) builds = true;
          for (const service of Object.values(env.services ?? {})) {
            if (service.image) images.add(service.image);
            if (service.build) builds = true;
          }
        }
    let index = 0;
    for (const image of images)
      await imageCached(
        ctx,
        command,
        executable,
        image,
        `task-image-${index++}`,
        [],
      );
    if (builds)
      ctx.unchecked(
        'task-builds',
        'Task images require builds. Doctor does not build or fetch images.',
      );
  } else {
    ctx.unchecked(
      'docker-capacity',
      'Selected task metadata is unavailable; Docker capacity was observed but task requirements could not be compared.',
    );
    ctx.unchecked('task-images', 'Selected task metadata is unavailable.');
  }
  const gatewayImage =
    typeof environment?.config.nodeImage === 'string'
      ? environment.config.nodeImage
      : PINNED_NODE_IMAGE;
  await checkDockerDiskCapacity(ctx, command, executable, dockerInfo, {
    tasks: metadata.tasks,
    metadataComplete: metadata.tasks.length > 0,
    config: object(environment?.config ?? {}),
    gatewayImage,
  });
  const gateway = await imageCached(
    ctx,
    command,
    executable,
    gatewayImage,
    'gateway-image-cache',
    ['workspace-cache-mounts', 'gateway-model-access'],
  );
  if (!gateway) {
    ctx.unchecked(
      'workspace-cache-mounts',
      'The SDK gateway image is unavailable.',
    );
    ctx.unchecked(
      'gateway-model-access',
      'The SDK gateway image is unavailable.',
    );
    return;
  }
  if (!dockerLayersAreLocal(dockerInfo)) {
    ctx.unchecked(
      'workspace-cache-mounts',
      'The daemon snapshotter does not establish that cached layer content is local; no container helper was started.',
    );
    ctx.unchecked(
      'gateway-model-access',
      'The daemon snapshotter does not establish that cached layer content is local; no container helper was started.',
    );
    return;
  }
  const platform =
    typeof environment?.config.platform === 'string'
      ? environment.config.platform
      : 'linux/amd64';
  const platformArgs = ['--platform', platform];
  if (metadata.sourceDirectory) {
    await ctx.check('workspace-cache-mounts', async (signal) => {
      const marker = join(ctx.directory, 'mount-marker');
      await writeFile(marker, 'doctor');
      await containerProbe(
        command,
        executable,
        gatewayImage,
        [
          ...platformArgs,
          '--network=none',
          '--mount',
          `type=bind,source=${ctx.directory},target=/owned,readonly`,
          '--mount',
          `type=bind,source=${metadata.sourceDirectory},target=/dataset,readonly`,
        ],
        "const f=require('node:fs');f.accessSync('/owned/mount-marker');f.readdirSync('/dataset');",
        signal,
      );
    });
  } else
    ctx.unchecked(
      'workspace-cache-mounts',
      'A selected local or cached dataset directory is unavailable.',
    );
  if (!loaded || !servicesReady) {
    ctx.unchecked(
      'gateway-model-access',
      'The SDK effective configuration or model service prerequisites are unavailable.',
    );
    return;
  }
  await ctx.check('gateway-model-access', async (signal) => {
    const name = loaded.experiment.solver.service;
    const service = object(
      plain(ctx.binding.config.services)[name],
      `services.${name}`,
    );
    const endpoint = new URL(
      expand(
        string(service.base_url, `services.${name}.base_url`),
        `services.${name}.base_url`,
      ),
    );
    if (endpoint.username || endpoint.password)
      throw new Error(`services.${name}.base_url must not contain credentials`);
    if (['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))
      endpoint.hostname = 'host.docker.internal';
    const key =
      service.api_key === undefined
        ? ''
        : expand(string(service.api_key), `services.${name}.api_key`);
    const model = expand(string(service.model), `services.${name}.model`);
    const script =
      "let t='';for await(const c of process.stdin)t+=c;const x=JSON.parse(t);const r=await fetch(x.endpoint.replace(/\\/$/,'')+'/models',{headers:{authorization:'Bearer '+x.key},signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Model list returned HTTP '+r.status);const b=await r.json();if(!Array.isArray(b.data)||!b.data.some(m=>m.id===x.model))throw Error('Configured model is absent from model list');console.log('model visible');";
    await containerProbe(
      command,
      executable,
      gatewayImage,
      [
        ...platformArgs,
        '-i',
        '--add-host',
        'host.docker.internal:host-gateway',
      ],
      script,
      signal,
      JSON.stringify({ endpoint: endpoint.href, key, model }),
    );
  });
}

async function cachedTasks(
  ctx: DoctorContext,
  loaded: LoadedConfig,
): Promise<{ tasks: PreparedTask[]; sourceDirectory?: string }> {
  const result: { tasks: PreparedTask[]; sourceDirectory?: string } = {
    tasks: [],
  };
  if (loaded.experiment.benchmark.name !== 'harbor') {
    ctx.unchecked(
      'task-metadata',
      `No bundled cache-only task probe for SDK benchmark ${loaded.experiment.benchmark.name}.`,
    );
    return result;
  }
  const config = parseHarborConfig(loaded.experiment.benchmark.config);
  if (!config.source) {
    ctx.unchecked(
      'task-metadata',
      `Dataset ${config.dataset} uses registry discovery; doctor will not fetch registry or task objects.`,
    );
    return result;
  }
  const sourceField =
    config.source.kind === 'local'
      ? 'benchmark.config.source.path'
      : 'benchmark.config.cacheDir';
  const sourcePath =
    config.source.kind === 'local' ? config.source.path : config.cacheDir;
  if (!isAbsolute(sourcePath)) {
    ctx.unchecked(
      'task-metadata',
      `${sourceField} is relative to the per-evaluation SDK configuration directory. Its runtime location cannot be established before launch; use an absolute path or an environment reference that resolves to one.`,
    );
    return result;
  }
  const directory =
    config.source.kind === 'local'
      ? resolve(config.source.path)
      : join(
          resolve(config.cacheDir),
          'snapshots',
          fingerprintConfig(config.source),
        );
  let exists = false;
  let absent = false;
  const inspected = await ctx.check(
    config.source.kind === 'local'
      ? 'dataset-source'
      : 'dataset-cache-inspection',
    async () => {
      const info = await lstat(directory).catch((error: unknown) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return null;
        throw error;
      });
      exists = info?.isDirectory() === true;
      absent = !exists;
      if (!exists && config.source?.kind === 'local')
        throw new Error(
          `Required benchmark.config.source.path directory is missing: ${directory}`,
        );
    },
  );
  if (!inspected && !absent) {
    ctx.unchecked(
      'task-metadata',
      'The configured dataset location could not be inspected.',
    );
    return result;
  }
  if (!exists) {
    ctx.unchecked(
      'task-metadata',
      `Dataset ${config.dataset} is not available at ${directory}. No dataset was fetched.`,
    );
    ctx.missing({
      field:
        config.source.kind === 'local'
          ? 'benchmark.config.source.path'
          : 'benchmark.config.cacheDir',
      kind: config.source.kind === 'local' ? 'directory' : 'dataset',
      reference: directory,
      checksNotRun: ['task-metadata', 'workspace-cache-mounts'],
    });
    return result;
  }
  result.sourceDirectory = directory;
  const valid = await ctx.check(
    'task-metadata',
    async (signal) => {
      const verifier =
        loaded.experiment.verifier?.name === 'harbor-python'
          ? new HarborPythonVerifier(
              parsePythonVerifierConfig(loaded.experiment.verifier.config),
              {
                services: {},
                solverService: loaded.experiment.solver.service,
                verifierService: loaded.experiment.verifier.service,
                configDirectory: dirname(ctx.recipe.sourcePath),
                resolvePath: resolve,
              },
            )
          : new HarborShellVerifier();
      // Use the admitted snapshot as a local input. Remote source resolution can fetch
      // even on a warm cache, so it is deliberately never called by doctor.
      const benchmark = new HarborBenchmark(
        {
          ...config,
          source: {
            kind: 'local',
            path: directory,
            ...(config.source?.hostPlatform === undefined
              ? {}
              : { hostPlatform: config.source.hostPlatform }),
          },
          cacheDir: ctx.directory,
        },
        undefined,
        verifier,
      );
      const source = await benchmark.resolveSource(null, signal);
      const selected = new Set(taskIds(ctx.recipe.policyConfig));
      for await (const ref of benchmark.enumerate(source, signal)) {
        if (selected.size && !selected.has(ref.id)) continue;
        result.tasks.push(await benchmark.prepare(ref, source, signal));
      }
      for (const id of selected)
        if (!result.tasks.some((task) => task.input.id === id))
          throw new Error(
            `Selected task is absent from dataset ${config.dataset}: ${id}`,
          );
      if (!result.tasks.length)
        throw new Error(
          `Dataset ${config.dataset} contains no selected tasks.`,
        );
    },
    { timeoutMs: 60000 },
  );
  if (!valid) result.tasks = [];
  return result;
}

async function agentbench(ctx: DoctorContext, command: Command): Promise<void> {
  let prepared: unknown;
  const compatible = await ctx.check('configuration', async () => {
    if (
      ['application.inference', 'application.kernel'].includes(
        ctx.recipe.application.pluginId,
      )
    )
      throw new Error(
        'evaluator.agentbench requires an Application with the agentbundle capability.',
      );
    prepared = prepareAgentbench(ctx.binding.config, {
      taskIds: [...new Set(taskIds(ctx.recipe.policyConfig))],
      execution: { directory: ctx.directory },
      directory: ctx.directory,
    });
  });
  let loaded: LoadedConfig | undefined;
  if (compatible)
    await ctx.check('sdk-configuration', async () => {
      loaded = await loadSdkConfig(ctx, prepared);
    });
  else ctx.unchecked('sdk-configuration', 'Adapter configuration failed.');
  const servicesReady = await ctx.check('services', async () => {
    const required = new Set([
      loaded?.experiment.solver.service ?? 'default',
      loaded?.experiment.verifier?.service,
    ]);
    for (const [name, value] of Object.entries(
      object(ctx.binding.config.services, 'services'),
    )) {
      const service = object(value, `services.${name}`);
      for (const field of ['model', 'base_url'])
        expand(
          string(service[field], `services.${name}.${field}`),
          `services.${name}.${field}`,
        );
      if (required.has(name) && service.api_key === undefined)
        throw new Error(
          `services.${name}.api_key is required by the selected solver or verifier.`,
        );
      if (service.api_key !== undefined)
        expand(string(service.api_key), `services.${name}.api_key`);
    }
  });
  let metadata: { tasks: PreparedTask[]; sourceDirectory?: string } = {
    tasks: [],
  };
  if (loaded) metadata = await cachedTasks(ctx, loaded);
  else
    ctx.unchecked('task-metadata', 'SDK configuration could not be resolved.');
  await checkDocker(ctx, command, loaded, metadata, servicesReady);
}

async function inferencebench(ctx: DoctorContext): Promise<void> {
  let prepared: unknown;
  const valid = await ctx.check('configuration', async () => {
    if (
      ['application.agentbundle', 'application.kernel'].includes(
        ctx.recipe.application.pluginId,
      )
    )
      throw new Error(
        'evaluator.inferencebench requires an Application with the inference-endpoint capability.',
      );
    const endpoint = plain(ctx.recipe.application.config.endpoint);
    prepared = prepareInferencebench(ctx.binding.config, {
      execution: {
        model: string(endpoint.model, 'application.config.endpoint.model'),
        baseUrl: 'http://127.0.0.1:1',
      },
      directory: ctx.directory,
    });
  });
  if (valid)
    await ctx.check('sdk-configuration', async () => {
      await loadSdkConfig(ctx, prepared);
    });
  else ctx.unchecked('sdk-configuration', 'Adapter configuration failed.');
  ctx.unchecked(
    'inference-endpoint',
    'The Application creates the endpoint during an experiment. Doctor did not launch an inference service.',
  );
}

async function operatorbench(ctx: DoctorContext): Promise<void> {
  const directory = string(
    object(ctx.binding.config.task, 'task').directory,
    'task.directory',
  );
  let task: Awaited<ReturnType<typeof loadOperatorTask>> | undefined;
  const valid = await ctx.check('operator-task', async () => {
    for (const name of ['task.json', 'problem.py', 'test.py']) {
      const path = join(directory, name);
      const exists = await lstat(path).catch((error: unknown) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return null;
        throw error;
      });
      if (!exists) {
        ctx.missing({
          field: `task.${name}`,
          kind: 'file',
          reference: path,
          checksNotRun: ['sdk-configuration'],
        });
        throw new Error(`Required operator task file is missing: ${path}`);
      }
    }
    task = await loadOperatorTask(directory);
  });
  if (!valid || !task) {
    ctx.unchecked('sdk-configuration', 'Operator task validation failed.');
    return;
  }
  const selected = task.cases[0];
  await ctx.check('sdk-configuration', async () => {
    const prepared = prepareOperatorbench(
      { ...ctx.binding.config, task: { directory } },
      {
        selected,
        operation: 'evaluate',
        directory: ctx.directory,
        manifest: join(ctx.directory, 'manifest.json'),
      },
    );
    await loadSdkConfig(ctx, prepared);
  });
}

/** External service calls are injectable so tests never need Docker or model credentials. */
export function createEvaluatorChecks(
  command: Command = runCommand,
): Readonly<Record<string, DoctorScript>> {
  return {
    'evaluator.agentbench': (ctx) => agentbench(ctx, command),
    'evaluator.inferencebench': inferencebench,
    'evaluator.operatorbench': operatorbench,
  };
}

export const evaluatorChecks = createEvaluatorChecks();
