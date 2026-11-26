import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DoctorContext, DoctorRule } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { projectMarker } from '../shared/agent-editing/project.js';
import { executablePath } from '../shared/doctor/executable.js';
import { runCommand } from '../shared/doctor/process.js';
import { codexCommand } from './executable.js';
import type { AgentCodexConfig } from './schema.js';

interface CodexDiagnostics {
  executable: string;
  args: string[];
  supportsDoctor: boolean;
  supportsNetworkOnly: boolean;
}

export function checkCodexAgent(
  context: DoctorContext<AgentCodexConfig>,
): DoctorRule[] {
  let command: CodexDiagnostics | undefined;
  let diagnosis: Awaited<ReturnType<typeof runCodexDiagnostics>> | undefined;
  const isExecutableAvailable = async (
    signal: AbortSignal,
  ): Promise<boolean> => {
    command = await inspectCodexExecutable(context, signal);
    return true;
  };
  const isDoctorHealthy = async (signal: AbortSignal): Promise<boolean> => {
    if (!command) return false;
    diagnosis = await runCodexDiagnostics(context, command, signal);
    return true;
  };

  return [
    {
      id: 'executable',
      check: isExecutableAvailable,
      reason:
        'The proposal-side Codex executable could not provide CLI help; check agent.codex.executable and the Codex installation.',
    },
    {
      id: 'doctor',
      get check() {
        return command?.supportsDoctor ? isDoctorHealthy : undefined;
      },
      get reason() {
        return command?.supportsDoctor
          ? 'Proposal-side Codex doctor could not complete its native health checks.'
          : 'The configured Codex CLI does not advertise doctor with JSON output; install a version that supports it.';
      },
      get details() {
        return command?.supportsDoctor
          ? {
              modelList: 'unchecked',
              providerReachability: 'unchecked',
              ...diagnosis?.details,
              ...(diagnosis ? { observation: diagnosis.reason } : {}),
            }
          : undefined;
      },
    },
    {
      id: 'model-access',
      get reason() {
        return command?.supportsDoctor
          ? 'Codex doctor does not establish that a valid model list contains the configured model; proposal-side model availability remains unchecked.'
          : 'Proposal-side model access was not checked because this Codex CLI does not support a machine-readable doctor report.';
      },
    },
  ];
}

async function inspectCodexExecutable(
  context: DoctorContext,
  signal: AbortSignal,
): Promise<CodexDiagnostics> {
  const configured =
    context.binding.config.executable === undefined
      ? 'codex'
      : string(context.binding.config.executable);
  const command = codexCommand(configured);
  const executable = await executablePath(
    command.executable,
    context.runtime.rootDirectory,
  );
  const launch = { executable, args: command.args };
  try {
    const help = await runCommand(executable, [...command.args, '--help'], {
      signal,
      cwd: context.runtime.rootDirectory,
    });
    // Older CLIs can interpret an unknown subcommand as a prompt.
    if (!/^\s{2,}doctor\s+\S/m.test(help.stdout))
      return { ...launch, supportsDoctor: false, supportsNetworkOnly: false };
    const doctorHelp = await runCommand(
      executable,
      [...command.args, 'doctor', '--help'],
      { signal, cwd: context.runtime.rootDirectory },
    );
    return {
      ...launch,
      supportsDoctor: /(?:^|\s)--json(?:\s|$)/m.test(doctorHelp.stdout),
      supportsNetworkOnly: /(?:^|\s)--network-only(?:\s|$)/m.test(
        doctorHelp.stdout,
      ),
    };
  } catch {
    throw new Error(
      'The proposal-side Codex executable could not provide CLI help; check agent.codex.executable and the Codex installation.',
    );
  }
}

async function runCodexDiagnostics(
  context: DoctorContext<AgentCodexConfig>,
  command: CodexDiagnostics,
  signal: AbortSignal,
): Promise<{
  reason: string;
  details: { modelList: string; providerReachability: string };
}> {
  const overrides = [
    '-c',
    `project_root_markers=[${JSON.stringify(projectMarker)}]`,
  ];
  // Runtime-only options may be invalid for the diagnostic subcommand.
  const options = context.binding.config.options ?? [];
  for (let index = 0; index < options.length; index++) {
    const arg = options[index]!;
    if (arg === '-c' || arg === '--config') {
      const value = options[++index];
      if (value !== undefined) overrides.push(arg, value);
    } else if (arg.startsWith('-c') || arg.startsWith('--config=')) {
      overrides.push(arg);
    }
  }
  const reason =
    'Proposal-side Codex doctor completed its native health checks without establishing model-list availability.';
  const details = { modelList: 'unchecked', providerReachability: 'unchecked' };
  let stdout: string;
  const directory = await mkdtemp(join(context.directory, 'codex-doctor-'));
  try {
    await writeFile(join(directory, projectMarker), '', { flag: 'wx' });
    ({ stdout } = await runCommand(
      command.executable,
      [
        ...command.args,
        ...overrides,
        'doctor',
        '--json',
        ...(command.supportsNetworkOnly ? ['--network-only'] : []),
      ],
      { signal, cwd: directory },
    ));
  } catch {
    throw new Error(
      signal.aborted
        ? 'Proposal-side Codex doctor timed out or was cancelled; check the model-service address and proposal environment network.'
        : 'Proposal-side Codex doctor could not complete; check Codex configuration, credentials and the proposal environment network.',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  let report: ReturnType<typeof object>;
  try {
    report = object(JSON.parse(stdout));
    if (
      report.schemaVersion !== 1 ||
      !['ok', 'warning', 'error'].includes(string(report.overallStatus))
    )
      throw new Error('Unsupported native doctor report');
    const checks = object(report.checks);
    if (Object.keys(checks).length === 0)
      throw new Error('Empty native doctor report');
    for (const check of Object.values(checks)) {
      const status = string(object(check).status);
      if (!['ok', 'warning', 'error', 'skipped'].includes(status))
        throw new Error('Unknown native doctor status');
    }
  } catch {
    throw new Error(
      'Proposal-side Codex doctor returned an invalid or unsupported JSON report; check the configured Codex CLI version.',
    );
  }
  const checks = object(report.checks);
  if (
    report.overallStatus === 'error' ||
    Object.values(checks).some((check) => object(check).status === 'error')
  )
    throw new Error(
      'Proposal-side Codex doctor reported a health or model-service failure; check Codex configuration, credentials and network.',
    );
  const reachability = checks['network.provider_reachability'];
  if (reachability && object(reachability).status === 'ok') {
    return {
      reason:
        'Proposal-side Codex doctor reached the configured model service without establishing model-list availability.',
      details: { ...details, providerReachability: 'passed' },
    };
  }
  return { reason, details };
}
