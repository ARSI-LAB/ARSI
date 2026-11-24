import {
  realpath,
  readFile,
  mkdir,
  mkdtemp,
  copyFile,
  chmod,
  writeFile,
  rm,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { JsonObject } from '../../contracts/index.js';
import { object } from '../../shared/json.js';
import { nativeAgentCommand } from '../shared/native-agent/executable.js';
import { runCommand } from '../shared/doctor/process.js';

import type { AgentSandboxMode } from '../shared/native-agent/sandbox.js';

export type DshSandboxMode = AgentSandboxMode;

const requiredRows: Record<string, string> = {
  sandbox: '@deepseek-ai/dsh-sandbox-local',
  'sandbox-policy': '@deepseek-ai/dsh-sandbox-policy',
  'bash-sandbox': '@deepseek-ai/dsh-bash-sandbox',
  'fs-sandbox': '@deepseek-ai/dsh-fs-sandbox',
  approval: '@deepseek-ai/dsh-user-approval',
  tools: '@deepseek-ai/dsh-tools',
  'headless-runner': '@deepseek-ai/dsh-headless',
  permission: '@deepseek-ai/dsh-permission-presets',
  credentials: '@deepseek-ai/dsh-credentials-local',
  authorization: '@deepseek-ai/dsh-authorization',
  'deepseek-account': '@deepseek-ai/dsh-deepseek-account-platform',
};
const disabledRows = new Set([
  'plan-mode',
  'settings',
  'config-editor',
  'hmr',
  'timer',
  'plugin-manager',
  'tool-plugin-manager',
  'mcp-resources',
  'ptc-runtime',
  'workflow-ptc',
  'tool-workflow',
  'tool-goal',
  'tool-ralph',
  'tool-todo',
  'subagent',
  'subagent-spawn-in-process',
  'subagent-fork-in-process',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-subagent-control',
  'tool-subagent-list-agents',
]);

/** Only installation-owned base/headless rows may survive an explicit sandbox. */
export function dshSandboxPatches(
  mode: Exclude<DshSandboxMode, 'inherit'>,
  directory: string,
  defaults: readonly JsonObject[],
  effective: readonly JsonObject[],
  guardPath: string,
): JsonObject[] {
  const entryFields = new Set([
    'id',
    'name',
    'config',
    'disabled',
    'inject',
    'intercept',
    'isolate',
  ]);
  if (
    effective.some((row) =>
      Object.keys(row).some((key) => !entryFields.has(key)),
    )
  )
    throw new Error(
      'DSH sandbox cannot constrain the inherited profile entry fields',
    );
  for (const [id, name] of Object.entries(requiredRows))
    if (
      !defaults.some((row) => row.id === id && row.name === name) ||
      !effective.some((row) => row.id === id && row.name === name && !row.group)
    )
      throw new Error(`DSH sandbox requires the native ${id} capability`);
  if (new Set(effective.map((row) => row.id)).size !== effective.length)
    throw new Error('DSH sandbox requires unique profile entry IDs');
  const names = new Map(defaults.map((row) => [row.id, row.name]));
  const patches: JsonObject[] = effective.map((row): JsonObject => {
    if (typeof row.id !== 'string')
      throw new Error('DSH sandbox requires profile entries with stable IDs');
    const name = names.get(row.id);
    if (
      typeof name !== 'string' ||
      row.name !== name ||
      disabledRows.has(row.id) ||
      (row.id.startsWith('tool-') &&
        !['tool-bash', 'tool-fs', 'tool-fs-search', 'tool-skill'].includes(
          row.id,
        ))
    )
      return { id: row.id, disabled: true };
    const native = defaults.find((entry) => entry.id === row.id)!;
    const provider = [
      'agent-default-model',
      'llm-deepseek',
      'llm-pi-ai',
    ].includes(row.id);
    const config = provider
      ? (row.config ?? native.config ?? {})
      : (native.config ?? {});
    if (provider && JSON.stringify(config).includes('"__jsExpr":'))
      throw new Error(
        'DSH sandbox requires literal model and provider configuration',
      );
    return {
      id: row.id,
      name,
      config,
      disabled: native.disabled ?? false,
      inject: native.inject ?? [],
      intercept: native.intercept ?? {},
      isolate: native.isolate ?? {},
    };
  });
  patches.push(
    {
      id: 'sandbox',
      disabled: false,
      config: {
        runnerCommand: [],
        runnerFailureSignatures: [],
        probeTimeoutMs: 5000,
      },
    },
    {
      id: 'sandbox-policy',
      disabled: false,
      config: { mode, workspaceRoot: directory },
    },
    { id: 'bash-sandbox', disabled: false },
    { id: 'fs-sandbox', disabled: false, config: { cwd: directory } },
    { id: 'approval', disabled: false, config: { policy: 'never' } },
    { id: 'tools', config: { mode: 'native' } },
    {
      id: 'permission',
      config: {
        defaultPreset: mode,
        presets: { [mode]: { sandbox: mode, approval: 'never' } },
      },
    },
    { id: 'headless-runner', inject: ['headlessStartup', 'rsiSandboxReady'] },
    { insert: [{ id: 'rsi-sandbox-guard', name: guardPath }] },
  );
  return patches;
}

function sandboxGuard(mode: string, directory: string): string {
  return `import { spawnSync } from 'node:child_process';
export const name = 'rsi-sandbox-guard';
export const inject = ['sandbox', 'sandboxPolicy', 'shell', 'fs', 'tools'];
export async function apply(ctx) {
  const policy = ctx.sandboxPolicy.resolve();
  const fields = new Set(['mode', 'workspaceRoot', 'sessionId']);
  if (
    Object.keys(policy).some((key) => !fields.has(key)) ||
    policy.mode !== ${JSON.stringify(mode)} ||
    policy.workspaceRoot !== ${JSON.stringify(directory)} ||
    ctx.fs.sandboxMode !== policy.mode ||
    ctx.shell.sandboxMode !== policy.mode
  ) throw new Error('DSH sandbox policy did not become effective');
  const wrapped = await ctx.sandbox.confine(['/bin/true'], policy);
  const probe = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
    stdio: 'ignore', timeout: 5000,
  });
  if (wrapped.enforcement !== 'full' || probe.status !== 0)
    throw new Error('DSH sandbox requires full native enforcement');
  const allowed = ['bash', 'read', 'read_image', 'glob', 'grep', 'skill'];
  ctx.effect(() => ctx.tools.guard((call) =>
    allowed.includes(call.name) ? undefined : 'Tool is unavailable in the RSI sandbox'
  ));
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: allowed });
  });
  ctx.provide('rsiSandboxReady', true);
}
`;
}

/** Resolve the installed CLI's modules, never the project or profile's packages. */
async function dshInstallation(executable: string): Promise<string> {
  const command = await nativeAgentCommand(executable);
  let directory = dirname(await realpath(command.args[0] ?? command.command));
  while (directory !== dirname(directory)) {
    try {
      const manifest = object(
        JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')),
      );
      if (manifest.name === '@deepseek-ai/dsh')
        return join(directory, 'package.json');
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
    }
    directory = dirname(directory);
  }
  throw new Error(
    'DSH sandbox requires an installed @deepseek-ai/dsh executable',
  );
}

const nativeProbe = `
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [installation, profile, mode, workspaceRoot] = process.argv.slice(1);
const require = createRequire(installation);
const { Context } = await import(require.resolve('@deepseek-ai/cordis'));
const { LocalSandboxProvider } = await import(require.resolve('@deepseek-ai/dsh-sandbox-local'));
const { resolveDshHome } = await import(require.resolve('@deepseek-ai/dsh-home-paths'));
const { loadProfileDirectory, loadOptionalPatches, composeEntries } =
  await import(require.resolve('@deepseek-ai/dsh-app-boot'));
const native = loadProfileDirectory('rsi', profile, installation, { userLayer: false });
if (native.skippedBundles.length) throw new Error('DSH native bundles are unavailable');
const source = join(resolveDshHome(), 'profiles', 'headless');
const inherited = existsSync(join(source, 'package.json'))
  ? loadProfileDirectory('rsi', source, installation)
  : native;
if (inherited.skippedBundles.length) throw new Error('DSH profile bundles are unavailable');
const defaults = composeEntries([native.layers.flatMap((layer) => layer.patches)]);
const effective = composeEntries([
  inherited.layers.flatMap((layer) => layer.patches),
  inherited.patches,
  loadOptionalPatches('rsi', join(resolveDshHome(), 'cordis.patch.yml')) ?? [],
]);
const ctx = new Context();
try {
  ctx.plugin(LocalSandboxProvider, {});
  await ctx.fiber.await();
  const wrapped = await ctx.sandbox.confine(['/bin/true'], { mode, workspaceRoot });
  const probe = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
    stdio: 'ignore', timeout: 5000,
  });
  if (wrapped.enforcement !== 'full' || probe.status !== 0)
    throw new Error('DSH sandbox requires full native enforcement');
  const cli = JSON.parse(readFileSync(installation, 'utf8'));
  const headless = JSON.parse(readFileSync(join(dirname(require.resolve('@deepseek-ai/dsh-headless')), '..', 'package.json'), 'utf8'));
  console.log(JSON.stringify({
    defaults, effective, home: resolveDshHome(),
    legacyFinal: cli.version === '0.1.7-rc.2' && headless.version === '0.1.7-rc.2',
  }));
} finally { await ctx.fiber.dispose(); }
`;

export interface DshSandboxLaunch {
  legacyFinal: boolean;
  patches: JsonObject[];
  env: NodeJS.ProcessEnv;
  dispose(): Promise<void>;
}

/** Shared Doctor/startup preparation never boots or repairs the host profile. */
export async function prepareDshSandbox(options: {
  executable: string;
  mode: Exclude<DshSandboxMode, 'inherit'>;
  directory: string;
  artifacts: string;
  signal: AbortSignal;
}): Promise<DshSandboxLaunch> {
  if (process.platform !== 'linux')
    throw new Error('Explicit DSH sandbox modes require Linux');
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(15000)]);
  signal.throwIfAborted();
  await mkdir(options.artifacts, { recursive: true });
  const state = await mkdtemp(join(options.artifacts, 'dsh-sandbox-'));
  const dispose = (): Promise<void> =>
    rm(state, { recursive: true, force: true });
  try {
    const installation = await dshInstallation(options.executable);
    const profile = join(state, 'profiles', 'headless');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(
      join(profile, 'package.json'),
      JSON.stringify({
        name: 'rsi-dsh-sandbox',
        private: true,
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
          },
        },
      }),
      { mode: 0o600 },
    );
    const { stdout } = await runCommand(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        nativeProbe,
        installation,
        profile,
        options.mode,
        options.directory,
      ],
      { signal, cwd: options.directory },
    );
    const native = object(JSON.parse(stdout));
    if (
      !Array.isArray(native.defaults) ||
      !Array.isArray(native.effective) ||
      typeof native.home !== 'string'
    )
      throw new Error('DSH native sandbox composition is unavailable');
    for (const file of ['.credentials.yaml', '.env']) {
      try {
        await copyFile(join(native.home, file), join(state, file));
        await chmod(join(state, file), 0o600);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
      }
    }
    const guardPath = join(state, 'guard.mjs');
    await writeFile(guardPath, sandboxGuard(options.mode, options.directory), {
      mode: 0o600,
    });
    const patches = dshSandboxPatches(
      options.mode,
      options.directory,
      native.defaults.map((row) => object(row)),
      native.effective.map((row) => object(row)),
      guardPath,
    );
    return {
      legacyFinal: native.legacyFinal === true,
      patches,
      env: {
        ...process.env,
        DSH_HOME: state,
        DSH_PERMISSION_MODE: options.mode,
        DSH_TELEMETRY_DISABLED: '1',
      },
      dispose,
    };
  } catch {
    await dispose();
    signal.throwIfAborted();
    throw new Error(
      'DSH sandbox preparation failed; check the native installation, profile, and Linux sandbox support',
    );
  }
}
