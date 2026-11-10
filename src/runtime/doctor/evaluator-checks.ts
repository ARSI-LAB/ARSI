import { lstat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { JsonObject, JsonValue } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { plain } from '../../plugins/shared/evaluator-adapter/data.js';
import { prepareEvaluationConfig as prepareAgentbench } from '../../plugins/evaluator-agentbench/service.js';
import { prepareEvaluationConfig as prepareInferencebench } from '../../plugins/evaluator-inferencebench/service.js';
import { prepareEvaluationConfig as prepareOperatorbench } from '../../plugins/evaluator-operatorbench/service.js';
import { loadOperatorTask } from '../../plugins/shared/operator-task.js';
import { sdkDoctor, type SdkDoctorRunner } from './evaluator-sdk.js';
import type { DoctorContext, DoctorScript } from './types.js';

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

async function networkConfigPath(ctx: DoctorContext): Promise<string> {
  if (process.env.EVALUATOR_NETWORK_CONFIG)
    return resolve(process.env.EVALUATOR_NETWORK_CONFIG);
  const configured = join(homedir(), '.ember-evaluator', 'network.yaml');
  try {
    await lstat(configured);
    return configured;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  // Native doctor must not initialize configuration in the user's home.
  const path = join(ctx.directory, 'network.yaml');
  await writeFile(path, '{}\n', { mode: 0o600 });
  return path;
}

async function bundleDirectory(ctx: DoctorContext): Promise<string> {
  const baseline = plain(ctx.recipe.application.config.baseline);
  if (typeof baseline.directory === 'string') return baseline.directory;
  if (typeof baseline.artifactRef === 'string') {
    const directory = join(ctx.directory, 'baseline');
    await ctx.runtime.artifacts.materialize(baseline.artifactRef, directory);
    return directory;
  }
  ctx.unchecked(
    'application-instance',
    'The Application supplies its instance during execution; SDK doctor uses a temporary path without establishing instance readiness.',
  );
  return ctx.directory;
}

async function prepare(ctx: DoctorContext): Promise<{
  configPath: string;
  networkConfigPath: string;
  env: NodeJS.ProcessEnv;
}> {
  const env = { ...process.env };
  let config: unknown;
  switch (ctx.binding.pluginId) {
    case 'evaluator.agentbench':
      if (
        ['application.inference', 'application.kernel'].includes(
          ctx.recipe.application.pluginId,
        )
      )
        throw new Error(
          'evaluator.agentbench requires an Application with the agentbundle capability.',
        );
      config = prepareAgentbench(ctx.binding.config, {
        taskIds: [...new Set(taskIds(ctx.recipe.policyConfig))],
        execution: { directory: await bundleDirectory(ctx) },
        directory: ctx.directory,
      });
      break;
    case 'evaluator.inferencebench': {
      if (
        ['application.agentbundle', 'application.kernel'].includes(
          ctx.recipe.application.pluginId,
        )
      )
        throw new Error(
          'evaluator.inferencebench requires an Application with the inference-endpoint capability.',
        );
      const endpoint = plain(ctx.recipe.application.config.endpoint);
      const credentials = plain(ctx.recipe.application.config.credentials);
      config = prepareInferencebench(ctx.binding.config, {
        execution: {
          model: string(endpoint.model, 'application.config.endpoint.model'),
          baseUrl: 'http://127.0.0.1:1',
          ...(typeof credentials.apiKeyEnv === 'string'
            ? { credentialRef: credentials.apiKeyEnv }
            : {}),
        },
        directory: ctx.directory,
      });
      break;
    }
    case 'evaluator.operatorbench': {
      const directory = string(
        object(ctx.binding.config.task, 'task').directory,
        'task.directory',
      );
      const task = await loadOperatorTask(directory);
      config = prepareOperatorbench(ctx.binding.config, {
        selected: task.cases[0]!,
        operation: 'evaluate',
        directory: ctx.directory,
        manifest: join(ctx.directory, 'manifest.json'),
      });
      env.RSI_KERNEL_REPLAY_NO_MODEL_KEY = 'not-a-secret-no-model-calls';
      break;
    }
    default:
      throw new Error(
        `No SDK configuration adapter for ${ctx.binding.pluginId}`,
      );
  }
  const configPath = join(ctx.directory, 'evaluator.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  return { configPath, networkConfigPath: await networkConfigPath(ctx), env };
}

type NativeStatus = 'passed' | 'failed' | 'not-checked';
type SdkReport = {
  checks: { name: string; status: NativeStatus; detail: string }[];
  network: JsonObject;
};

function report(value: unknown): SdkReport {
  const native = object(value, 'SDK doctor report');
  if (!Array.isArray(native.checks) || !native.checks.length)
    throw new Error('SDK doctor report.checks must be a nonempty array');
  const checks = native.checks.map((value): SdkReport['checks'][number] => {
    const check = object(value, 'SDK doctor check');
    const name = string(check.name, 'SDK doctor check.name');
    if (typeof check.detail !== 'string')
      throw new Error('SDK doctor check.detail must be a string');
    const detail = check.detail;
    const status = check.status;
    if (status !== 'passed' && status !== 'failed' && status !== 'not-checked')
      throw new Error('SDK doctor check has an unsupported status');
    return { name, status, detail };
  });
  const network = object(native.network, 'SDK doctor network');
  if (
    !['passed', 'failed', 'incomplete', 'not-checked'].includes(
      string(network.status),
    )
  )
    throw new Error('SDK doctor network has an unsupported status');
  if (!Array.isArray(network.probes))
    throw new Error('SDK doctor network.probes must be an array');
  for (const raw of network.probes) {
    const probe = object(raw, 'SDK doctor network probe');
    string(probe.name, 'SDK doctor network probe.name');
    if (typeof probe.evidence !== 'string')
      throw new Error('SDK doctor network probe.evidence must be a string');
    if (
      !['passed', 'failed', 'not-checked', 'not-applicable'].includes(
        string(probe.status),
      )
    )
      throw new Error('SDK doctor network probe has an unsupported status');
    if (
      network.status === 'passed' &&
      (probe.status === 'failed' || probe.status === 'not-checked')
    )
      throw new Error(
        'SDK doctor network summary contradicts its probe results',
      );
  }
  return { checks, network };
}

async function record(
  ctx: DoctorContext,
  id: string,
  status: string,
  reason: string,
  details?: JsonObject,
): Promise<void> {
  if (status !== 'passed' && status !== 'failed') {
    ctx.unchecked(id, reason, details);
    return;
  }
  await ctx.check(
    id,
    async () => {
      if (status === 'failed') throw new Error(reason);
    },
    { reason, ...(details ? { details } : {}) },
  );
}

async function evaluator(
  ctx: DoctorContext,
  run: SdkDoctorRunner,
): Promise<void> {
  let options: Awaited<ReturnType<typeof prepare>> | undefined;
  const configured = await ctx.check('configuration', async (signal) => {
    signal.throwIfAborted();
    options = await prepare(ctx);
  });
  if (!configured || !options) {
    ctx.unchecked(
      'sdk-doctor',
      'Evaluator SDK doctor was not run because its configuration could not be prepared.',
    );
    return;
  }
  let result: SdkReport;
  try {
    // The SDK owns the complete diagnostic workflow and its per-probe limits.
    result = report(await run({ ...options, signal: ctx.signal }));
    ctx.signal.throwIfAborted();
  } catch (error) {
    ctx.signal.throwIfAborted();
    await ctx.check('sdk-doctor', async () => {
      throw error;
    });
    return;
  }
  await record(
    ctx,
    'sdk-doctor',
    'passed',
    'Evaluator SDK doctor returned its diagnostic report.',
  );
  for (const [index, check] of result.checks.entries())
    await record(
      ctx,
      `sdk.check-${index}`,
      check.status,
      `${check.name}: ${check.detail}`,
      {
        sdkName: check.name,
        sdkStatus: check.status,
      },
    );
  const networkStatus = string(result.network.status);
  await record(
    ctx,
    'sdk.network',
    networkStatus,
    networkStatus === 'passed'
      ? 'Evaluator SDK network probes passed; see the SDK probe evidence for their scope.'
      : 'Evaluator SDK network probes did not all pass; inspect the SDK probe evidence and guidance.',
    result.network,
  );
  if (ctx.binding.pluginId === 'evaluator.agentbench') {
    ctx.unchecked(
      'model-access',
      'The installed Evaluator SDK doctor does not query model lists, so evaluation model availability is unchecked.',
    );
    ctx.unchecked(
      'docker-disk-capacity',
      'The installed Evaluator SDK doctor does not measure disk capacity, so evaluation storage sufficiency is unchecked.',
    );
  } else if (ctx.binding.pluginId === 'evaluator.inferencebench')
    ctx.unchecked(
      'inference-endpoint',
      'The Application creates the endpoint during execution; SDK doctor used a placeholder without establishing service readiness.',
    );
}

/** Only configuration adaptation and SDK diagnostic mapping belong to RSI. */
export function createEvaluatorChecks(
  run: SdkDoctorRunner = sdkDoctor,
): Readonly<Record<string, DoctorScript>> {
  return {
    'evaluator.agentbench': (ctx) => evaluator(ctx, run),
    'evaluator.inferencebench': (ctx) => evaluator(ctx, run),
    'evaluator.operatorbench': (ctx) => evaluator(ctx, run),
  };
}

export const evaluatorChecks = createEvaluatorChecks();
