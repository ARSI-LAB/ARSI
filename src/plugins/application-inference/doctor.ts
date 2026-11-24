import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DoctorContext, DoctorRule } from '../../contracts/index.js';
import { missingInputError } from '../../shared/doctor-check.js';
import { object, string } from '../../shared/json.js';
import { requireReadablePath } from '../shared/doctor/checks.js';
import { executablePath } from '../shared/doctor/executable.js';
import { runCommand } from '../shared/doctor/process.js';
import { readBaselineDirectory } from '../shared/file-application/doctor.js';
import { safePath } from '../shared/file-application/target.js';
import type {
  InferenceConfig,
  LocalInferenceConfig,
  RemoteInferenceConfig,
} from './schema.js';

export function checkInferenceApplication(
  context: DoctorContext<InferenceConfig>,
): DoctorRule[] {
  const config = context.binding.config;
  const apiKeyEnv = config.credentials?.apiKeyEnv;
  let directory: string;

  async function isBaselineAvailable(signal: AbortSignal): Promise<boolean> {
    directory = await readBaselineDirectory(context, undefined, signal);
    return true;
  }

  async function areLaunchPrerequisitesAvailable(
    signal: AbortSignal,
  ): Promise<boolean> {
    if ('remote' in config)
      await checkRemoteParameters(config.remote, directory, signal);
    else await checkLocalLaunch(config, directory);
    signal.throwIfAborted();
    return true;
  }

  function credentialsAvailable(): boolean {
    return apiKeyEnv === undefined || Boolean(process.env[apiKeyEnv]?.trim());
  }

  return [
    {
      id: 'baseline',
      check: isBaselineAvailable,
      reason:
        'Restore the baseline input files or correct the Target and baseline configuration.',
    },
    ...remoteInterpreterDoctorRules(config),
    {
      id: 'launch-prerequisites',
      check: areLaunchPrerequisitesAvailable,
      reason:
        'Correct the inference launch configuration and restore its required files.',
    },
    {
      id: 'credentials',
      check: credentialsAvailable,
      reason:
        apiKeyEnv === undefined
          ? 'No API key environment variable is required.'
          : `credentials.apiKeyEnv references missing or empty environment variable ${apiKeyEnv}. Set that variable before running the experiment.`,
    },
  ];
}

function remoteInterpreterDoctorRules(config: InferenceConfig): DoctorRule[] {
  if (!('remote' in config)) return [];
  return [
    {
      id: 'remote-executable',
      check: async (signal: AbortSignal): Promise<boolean> => {
        await checkRemoteInterpreter(config.remote, signal);
        return true;
      },
      reason:
        'Install or correct remote.executable so its version can be checked.',
    },
  ];
}

async function checkRemoteInterpreter(
  remote: RemoteInferenceConfig['remote'],
  signal: AbortSignal,
): Promise<void> {
  const executable = remote.executable ?? 'python3';
  await executablePath(executable, process.cwd());
  await runCommand(executable, ['--version'], { signal });
}

async function checkRemoteParameters(
  remote: RemoteInferenceConfig['remote'],
  baseline: string,
  signal: AbortSignal,
): Promise<void> {
  const parameters = join(
    baseline,
    safePath(remote.parametersFile ?? 'tuning.json'),
  );
  await requireReadablePath(parameters, 'remote.parametersFile', 'file');
  object(
    JSON.parse(await readFile(parameters, { encoding: 'utf8', signal })),
    'remote parameters',
  );
}

async function checkLocalLaunch(
  config: LocalInferenceConfig,
  baseline: string,
): Promise<void> {
  const { start, resources = {} } = config;
  const expand = (
    argument: LocalInferenceConfig['start']['argv'][number],
  ): string => {
    if (typeof argument === 'string') return argument;
    const base =
      argument.resource === 'workspace'
        ? baseline
        : argument.resource === 'port'
          ? '0'
          : string(
              resources[argument.resource],
              `resources.${argument.resource}`,
            );
    return argument.path === undefined
      ? base
      : join(base, safePath(argument.path));
  };
  const argv = start.argv.map(expand);
  const cwd =
    start.cwd === undefined ? baseline : join(baseline, safePath(start.cwd));
  await requireReadablePath(cwd, 'start.cwd', 'directory');
  await executablePath(string(argv[0], 'start.argv[0]'), cwd);
  for (const [index, argument] of start.argv.entries()) {
    if (typeof argument === 'string' || argument.resource === 'port') continue;
    const reference = resolve(cwd, expand(argument));
    try {
      await access(reference, constants.R_OK);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        throw missingInputError(
          { field: `start.argv.${index}`, kind: 'path', reference },
          error,
        );
      throw error;
    }
  }
}
