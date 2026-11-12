import { lstat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  DoctorContext,
  DoctorResult,
  JsonObject,
} from '../../../contracts/index.js';
import { runDoctorCheck } from '../../../shared/doctor-check.js';
import { errorText } from '../../../shared/errors.js';
import { object, string } from '../../../shared/json.js';
import type { SdkEvaluatorConfig } from './configuration.js';
import {
  sdkDoctor,
  type SdkDoctorOptions,
  type SdkDoctorRunner,
} from './doctor-sdk.js';

async function networkConfigPath(
  directory: string,
  signal: AbortSignal,
): Promise<string> {
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
  const path = join(directory, 'network.yaml');
  await writeFile(path, '{}\n', { mode: 0o600, signal });
  return path;
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

function doctorStatus(
  status: string,
): DoctorResult['checks'][number]['status'] {
  return status === 'passed' || status === 'failed' ? status : 'unchecked';
}

/** Report configuration preparation and any diagnostics produced by the SDK. */
export async function checkSdkDoctor(
  ctx: DoctorContext,
  prepareConfig: (
    ctx: DoctorContext,
    env: NodeJS.ProcessEnv,
  ) => SdkEvaluatorConfig | Promise<SdkEvaluatorConfig>,
  run: SdkDoctorRunner = sdkDoctor,
): Promise<{ checks: DoctorResult['checks']; reported: boolean }> {
  let options: Omit<SdkDoctorOptions, 'signal'> | undefined;
  const configuration = await runDoctorCheck(
    'configuration',
    async (signal) => {
      signal.throwIfAborted();
      const env = { ...process.env };
      const config = await prepareConfig(ctx, env);
      const configPath = join(ctx.directory, 'evaluator.json');
      await writeFile(configPath, JSON.stringify(config), {
        mode: 0o600,
        signal,
      });
      options = {
        configPath,
        networkConfigPath: await networkConfigPath(ctx.directory, signal),
        env,
      };
    },
    { signal: ctx.signal },
  );
  const checks: DoctorResult['checks'] = [configuration];
  if (configuration.status !== 'passed' || !options) {
    checks.push({
      id: 'sdk-doctor',
      status: 'unchecked',
      reason:
        'Evaluator SDK doctor was not run because its configuration could not be prepared.',
    });
    return { checks, reported: false };
  }
  let result: SdkReport;
  try {
    // The SDK owns the complete diagnostic workflow and its per-probe limits.
    result = report(await run({ ...options, signal: ctx.signal }));
    ctx.signal.throwIfAborted();
  } catch (error) {
    ctx.signal.throwIfAborted();
    checks.push({
      id: 'sdk-doctor',
      status: 'failed',
      reason: `${errorText(error)} Plugin availability is unknown unless established by another check.`,
    });
    return { checks, reported: false };
  }
  checks.push({
    id: 'sdk-doctor',
    status: 'passed',
    reason: 'Evaluator SDK doctor returned its diagnostic report.',
  });
  for (const [index, check] of result.checks.entries())
    checks.push({
      id: `sdk.check-${index}`,
      status: doctorStatus(check.status),
      reason: `${check.name}: ${check.detail}`,
      details: {
        sdkName: check.name,
        sdkStatus: check.status,
      },
    });
  const networkStatus = string(result.network.status);
  checks.push({
    id: 'sdk.network',
    status: doctorStatus(networkStatus),
    reason:
      networkStatus === 'passed'
        ? 'Evaluator SDK network probes passed; see the SDK probe evidence for their scope.'
        : 'Evaluator SDK network probes did not all pass; inspect the SDK probe evidence and guidance.',
    details: result.network,
  });
  return { checks, reported: true };
}
