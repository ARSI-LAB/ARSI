import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Candidate,
  JsonObject,
  Operation,
} from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import { parseConfig } from '../../shared/schema.js';
import {
  readTarget,
  type FileApplicationConfig,
} from '../../plugins/shared/file-application/files.js';
import { safePath } from '../../plugins/shared/file-application/target.js';
import { resolveModelConfig } from '../../plugins/agent-pi/service.js';
import { codexCommand } from '../../plugins/agent-codex/executable.js';
import { projectMarker } from '../../plugins/shared/agent-editing/project.js';
import type { DoctorContext, DoctorScript } from './types.js';
import { runCommand } from './process.js';
import { probeModelAccess } from './model-access.js';

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function requirePath(
  context: DoctorContext,
  path: string,
  field: string,
  kind: 'file' | 'directory',
  dependents: string[],
): Promise<void> {
  try {
    const stat = await lstat(path);
    if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())
      throw new Error(`${field}: expected a readable ${kind}: ${path}`);
    await access(path, constants.R_OK);
  } catch (error) {
    if (missing(error))
      context.missing({
        field,
        kind,
        reference: path,
        checksNotRun: dependents,
      });
    throw error;
  }
}

/** Resolve the same command search path used by a shell-free child process. */
async function executablePath(command: string, cwd: string): Promise<string> {
  const explicit = isAbsolute(command) || /[/\\]/.test(command);
  const extensions =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.EXE;.COM;.CMD;.BAT').split(';')]
      : [''];
  const bases = explicit
    ? [resolve(cwd, command)]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .map((entry) => join(entry || cwd, command));
  for (const base of bases) {
    for (const extension of extensions) {
      const candidate = base + extension;
      try {
        if (!(await lstat(candidate)).isFile()) continue;
        await access(
          candidate,
          process.platform === 'win32' ? constants.F_OK : constants.X_OK,
        );
        return candidate;
      } catch (error) {
        if (
          !missing(error) &&
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'EACCES'
          )
        )
          throw error;
      }
    }
  }
  throw new Error(
    `Executable is unavailable in the launch environment: ${command}`,
  );
}

async function baselineInputs(
  context: DoctorContext,
  dependents: string[],
): Promise<{ config: FileApplicationConfig; directory: string } | undefined> {
  let result: { config: FileApplicationConfig; directory: string } | undefined;
  const ready = await context.check('baseline', async (signal) => {
    const config = parseConfig<FileApplicationConfig>(
      context.binding.definition.configSchema,
      context.binding.config,
      `${context.binding.name}.config`,
    );
    if (typeof config.target.schema === 'string')
      await requirePath(
        context,
        config.target.schema,
        'target.schema',
        'file',
        dependents,
      );
    const { target } = await readTarget(config, context.runtime.rootDirectory);
    let directory: string;
    if ('directory' in config.baseline) {
      directory = resolve(
        context.runtime.rootDirectory,
        config.baseline.directory,
      );
      await requirePath(
        context,
        directory,
        'baseline.directory',
        'directory',
        dependents,
      );
    } else {
      directory = join(context.directory, 'baseline-input');
      try {
        await context.runtime.artifacts.materialize(
          config.baseline.artifactRef,
          directory,
        );
      } catch (error) {
        if (missing(error))
          context.missing({
            field: 'baseline.artifactRef',
            kind: 'artifact',
            reference: config.baseline.artifactRef,
            checksNotRun: dependents,
          });
        throw error;
      }
    }
    for (const entry of target.entries)
      if (entry.kind === 'file')
        await requirePath(
          context,
          join(directory, entry.path),
          `target.entries.${entry.path}`,
          'file',
          dependents,
        );
    if (context.binding.pluginId === 'application.agentbundle')
      await requirePath(
        context,
        join(directory, 'bundle.yaml'),
        'baseline.bundle.yaml',
        'file',
        dependents,
      );
    if (context.binding.pluginId === 'application.kernel')
      await requirePath(
        context,
        join(directory, 'input.py'),
        'baseline.input.py',
        'file',
        dependents,
      );
    signal.throwIfAborted();
    result = { config, directory };
  });
  return ready ? result : undefined;
}

async function fileApplication(context: DoctorContext): Promise<void> {
  const verification =
    context.binding.pluginId === 'application.agentbundle'
      ? 'verify-bundle'
      : 'verify-source';
  const inputs = await baselineInputs(context, [
    verification,
    'acquire-instance',
  ]);
  if (!inputs) {
    context.unchecked(verification, 'Baseline or Target prerequisites failed.');
    context.unchecked(
      'acquire-instance',
      'Baseline or Target prerequisites failed.',
    );
    return;
  }
  const candidates = new Map<string, Candidate>();
  const runtime = context.runtime.extend({
    experimentId: `doctor-${randomUUID()}`,
    async recordCandidate(
      artifactRef: string,
      parentRef: string | null,
    ): Promise<string> {
      const ref = `doctor-candidate-${randomUUID()}`;
      candidates.set(ref, {
        ref,
        artifactRef,
        parentRef,
        experimentId: this.experimentId,
      });
      return ref;
    },
    async readCandidate(ref: string): Promise<Candidate> {
      const candidate = candidates.get(ref);
      if (!candidate) throw new Error(`Unknown doctor candidate ${ref}`);
      return candidate;
    },
  });
  let operation: Operation | undefined;
  let candidateRef: string | undefined;
  try {
    const verified = await context.check(verification, async (signal) => {
      const scope = runtime.extend({ signal });
      operation = await context.binding.definition.create(
        context.binding.config,
        scope,
      );
      const result = object(
        await operation.execute({ action: 'initialize' }, scope),
      );
      if (result.action !== 'initialize')
        throw new Error('Application returned no initialization result');
      candidateRef = string(result.initialCandidateRef, 'initialCandidateRef');
    });
    if (!verified || !operation || !candidateRef) {
      context.unchecked(
        'acquire-instance',
        'Application initialization did not complete.',
      );
      return;
    }
    const application = operation;
    const initialCandidateRef = candidateRef;
    await context.check('acquire-instance', async (signal) => {
      const instanceId = `doctor-instance-${randomUUID()}`;
      const scope = runtime.extend({ signal });
      let acquired = false;
      try {
        const result = object(
          await application.execute(
            {
              action: 'acquire',
              candidateRef: initialCandidateRef,
              instanceId,
              capability:
                context.binding.pluginId === 'application.agentbundle'
                  ? 'agentbundle'
                  : 'kernel-source',
            },
            scope,
          ),
        );
        acquired = true;
        const execution = object(result.execution, 'execution');
        const directory = string(execution.directory, 'execution.directory');
        await access(directory, constants.R_OK);
        if (context.binding.pluginId === 'application.agentbundle')
          await readFile(join(directory, 'bundle.yaml'), 'utf8');
        else await readFile(join(directory, 'input.py'), 'utf8');
        signal.throwIfAborted();
      } finally {
        if (acquired) {
          await application.execute(
            { action: 'release', instanceId },
            runtime.extend({ signal: runtime.cleanup }),
          );
          const instance = await runtime.facts.read('instances', instanceId);
          if (instance.status !== 'released')
            throw new Error('Application instance release was not confirmed');
        }
      }
    });
  } finally {
    if (operation) {
      const application = operation;
      if (context.signal.aborted) await application.dispose();
      else await context.check('cleanup', async () => application.dispose());
    }
  }
}

async function inference(context: DoctorContext): Promise<void> {
  const inputs = await baselineInputs(context, ['launch-prerequisites']);
  if (!inputs) {
    context.unchecked(
      'launch-prerequisites',
      'Baseline or Target prerequisites failed.',
    );
    return;
  }
  await context.check('launch-prerequisites', async (signal) => {
    const config = context.binding.config;
    if (config.remote !== undefined) {
      const remote = object(config.remote);
      const executable =
        remote.executable === undefined ? 'python3' : string(remote.executable);
      await executablePath(executable, process.cwd());
      await runCommand(executable, ['--version'], { signal });
      await requirePath(
        context,
        string(remote.script),
        'remote.script',
        'file',
        [],
      );
      const parameters = join(
        inputs.directory,
        safePath(remote.parametersFile ?? 'tuning.json'),
      );
      await requirePath(
        context,
        parameters,
        'remote.parametersFile',
        'file',
        [],
      );
      object(
        JSON.parse(await readFile(parameters, 'utf8')),
        'remote parameters',
      );
    } else {
      const start = object(config.start);
      const resources = object(config.resources ?? {});
      if (!Array.isArray(start.argv))
        throw new Error('start.argv must be an array');
      const expand = (value: unknown): string => {
        if (typeof value === 'string') return value;
        const token = object(value, 'start.argv token');
        const resource = string(token.resource);
        const base =
          resource === 'workspace'
            ? inputs.directory
            : resource === 'port'
              ? '0'
              : string(resources[resource], `resources.${resource}`);
        return token.path === undefined
          ? base
          : join(base, safePath(token.path));
      };
      const argv = start.argv.map(expand);
      const cwd =
        start.cwd === undefined
          ? inputs.directory
          : join(inputs.directory, safePath(start.cwd));
      await requirePath(context, cwd, 'start.cwd', 'directory', []);
      await executablePath(string(argv[0], 'start.argv[0]'), cwd);
      for (const [index, value] of start.argv.entries()) {
        if (typeof value === 'object' && value !== null) {
          const token = object(value);
          if (token.resource !== 'port') {
            const reference = resolve(cwd, expand(value));
            await access(reference, constants.R_OK).catch((error: unknown) => {
              if (missing(error))
                context.missing({
                  field: `start.argv.${index}`,
                  kind: 'path',
                  reference,
                  checksNotRun: [],
                });
              throw error;
            });
          }
        }
      }
    }
    const credentials = object(config.credentials ?? {});
    if (credentials.apiKeyEnv !== undefined) {
      const name = string(credentials.apiKeyEnv);
      if (!process.env[name]?.trim())
        throw new Error(
          `credentials.apiKeyEnv references missing or empty environment variable ${name}`,
        );
    }
    // Creation validates launch settings but leaves service ownership to acquire.
    const operation = await context.binding.definition.create(
      config,
      context.runtime,
    );
    await operation.dispose();
    signal.throwIfAborted();
  });
}

async function pi(context: DoctorContext): Promise<void> {
  const configured = await context.check('model-config', async () => {
    const config = context.binding.config;
    const operation = await context.binding.definition.create(
      config,
      context.runtime,
    );
    try {
      const resolved = resolveModelConfig(config);
      let url: URL;
      try {
        url = new URL(resolved.base_url);
      } catch {
        throw new Error(
          'agent.pi base_url must resolve to an HTTP(S) endpoint',
        );
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error(
          'agent.pi base_url must resolve to a credential-free HTTP(S) endpoint',
        );
    } finally {
      await operation.dispose();
    }
  });
  if (!configured) {
    context.unchecked(
      'model-access',
      'Proposal model access was not checked because agent.pi model configuration is invalid.',
    );
    return;
  }
  const options: { reason?: string; details: JsonObject } = { details: {} };
  await context.check(
    'model-access',
    async (signal) => {
      const resolved = resolveModelConfig(context.binding.config);
      const result = await probeModelAccess(
        {
          side: 'Proposal',
          model: resolved.model,
          baseUrl: resolved.base_url,
          apiKey: resolved.api_key,
        },
        signal,
      );
      options.reason = result.reason;
      options.details = result.details;
      if (result.status === 'failed') throw new Error(result.reason);
    },
    options,
  );
}

async function codex(context: DoctorContext): Promise<void> {
  let launch: { executable: string; args: string[] } | undefined;
  let supportsDoctor = false;
  let supportsNetworkOnly = false;
  const available = await context.check('executable', async (signal) => {
    const configured =
      context.binding.config.executable === undefined
        ? 'codex'
        : string(context.binding.config.executable);
    const command = codexCommand(configured);
    const executable = await executablePath(
      command.executable,
      context.runtime.rootDirectory,
    );
    launch = { executable, args: command.args };
    try {
      const help = await runCommand(executable, [...command.args, '--help'], {
        signal,
        cwd: context.runtime.rootDirectory,
      });
      // Older CLIs can interpret an unknown subcommand as a prompt.
      if (!/^\s{2,}doctor\s+\S/m.test(help.stdout)) return;
      const doctorHelp = await runCommand(
        executable,
        [...command.args, 'doctor', '--help'],
        { signal, cwd: context.runtime.rootDirectory },
      );
      supportsDoctor = /(?:^|\s)--json(?:\s|$)/m.test(doctorHelp.stdout);
      supportsNetworkOnly = /(?:^|\s)--network-only(?:\s|$)/m.test(
        doctorHelp.stdout,
      );
    } catch {
      throw new Error(
        'The proposal-side Codex executable could not provide CLI help; check agent.codex.executable and the Codex installation.',
      );
    }
  });
  if (!available || !launch) {
    context.unchecked(
      'model-access',
      'Proposal-side model access was not checked because the Codex executable is unavailable.',
    );
    return;
  }
  if (!supportsDoctor) {
    context.unchecked(
      'doctor',
      'The configured Codex CLI does not advertise doctor with JSON output; install a version that supports it.',
    );
    context.unchecked(
      'model-access',
      'Proposal-side model access was not checked because this Codex CLI does not support a machine-readable doctor report.',
    );
    return;
  }
  const overrides = [
    '-c',
    `project_root_markers=[${JSON.stringify(projectMarker)}]`,
  ];
  for (const [field, key] of [
    ['model', 'model'],
    ['thinkingLevel', 'model_reasoning_effort'],
  ]) {
    const value = context.binding.config[field];
    if (value !== undefined)
      overrides.push('-c', `${key}=${JSON.stringify(string(value))}`);
  }
  const options: {
    reason?: string;
    details: { modelList: string; providerReachability: string };
  } = {
    details: { modelList: 'unchecked', providerReachability: 'unchecked' },
  };
  const command = launch;
  const failure = (reason: string): Error => {
    options.reason = reason;
    return new Error(reason);
  };
  await context.check(
    'doctor',
    async (signal) => {
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
            ...(supportsNetworkOnly ? ['--network-only'] : []),
          ],
          { signal, cwd: directory },
        ));
      } catch {
        throw failure(
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
        throw failure(
          'Proposal-side Codex doctor returned an invalid or unsupported JSON report; check the configured Codex CLI version.',
        );
      }
      const checks = object(report.checks);
      if (
        report.overallStatus === 'error' ||
        Object.values(checks).some((check) => object(check).status === 'error')
      )
        throw failure(
          'Proposal-side Codex doctor reported a health or model-service failure; check Codex configuration, credentials and network.',
        );
      const reachability = checks['network.provider_reachability'];
      options.reason =
        'Proposal-side Codex doctor completed its native health checks without establishing model-list availability.';
      if (reachability && object(reachability).status === 'ok') {
        options.details.providerReachability = 'passed';
        options.reason =
          'Proposal-side Codex doctor reached the configured model service without establishing model-list availability.';
      }
    },
    options,
  );
  context.unchecked(
    'model-access',
    'Codex doctor does not establish that a valid model list contains the configured model; proposal-side model availability remains unchecked.',
  );
}

export const applicationChecks: Readonly<Record<string, DoctorScript>> = {
  'application.agentbundle': fileApplication,
  'application.kernel': fileApplication,
  'application.inference': inference,
  'agent.pi': pi,
  'agent.codex': codex,
};
