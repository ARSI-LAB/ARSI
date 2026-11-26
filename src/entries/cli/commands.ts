import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { aborted } from 'node:util';
import {
  Argument,
  Command,
  InvalidArgumentError,
  type CommanderError,
} from 'commander';
import type { Runtime } from '../../runtime/context.js';
import type { RevisionApplication } from '../../runtime/revisions/application.js';
import { formatDoctorSummary } from '../../runtime/doctor/report.js';

export interface CommandContext {
  signal: AbortSignal;
  openRuntime(pluginDirectories: string[]): Promise<Runtime>;
  releaseRuntime(): Promise<void>;
}

interface CommandResult {
  exitCode: number;
  stdout?: string;
}

export async function runCommand(
  argv: string[],
  context: CommandContext,
): Promise<CommandResult> {
  let result: CommandResult = { exitCode: 0 };
  let commanderExit: CommanderError | undefined;
  const program = new Command('arsi')
    .description('Make everything rsi-able')
    .allowExcessArguments(false)
    .showHelpAfterError()
    .exitOverride((error) => {
      commanderExit = error;
      throw error;
    })
    .option(
      '--plugin-dir <directory>',
      'Load extensions from a directory (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .addHelpText(
      'after',
      '\nRun facts are saved in .rsi/ under the current directory.\nExtensions load from ~/.arsi/plugins/<name>/index.mjs by default.\nEach plugin directory must contain index.mjs exporting register(registry).',
    );
  program
    .command('run <recipe.yaml>')
    .description('Run or resume an experiment')
    .option('--id <experiment-id>', 'Set the experiment ID')
    .option('--resume', 'Resume an experiment using a compatible Recipe')
    .action(runExperiment);
  program
    .command('doctor <recipe.yaml>')
    .description('Check experiment configuration and runtime prerequisites')
    .option('--json', 'Output the full report as JSON')
    .action(runDoctorCommand);
  program
    .command('list')
    .description('List experiments, plugins, or policies')
    .addArgument(
      new Argument('[kind]').choices([
        'plugin',
        'plugins',
        'policy',
        'policies',
      ]),
    )
    .action(list);
  program
    .command('show <experiment-id>')
    .description('Show an experiment')
    .option(
      '--checkpoint',
      'Read committed partial output if the process did not save a terminal result',
    )
    .action((id: string, options: { checkpoint?: boolean }) =>
      runJson(({ manager }) => manager.get(id, options)),
    );
  program
    .command('cancel <experiment-id>')
    .description('Cancel an experiment')
    .action(cancelExperiment);
  program
    .command('cleanup [experiment-id]')
    .description(
      'Clean up a saved experiment or preview all experiments in this workspace',
    )
    .option(
      '--all',
      'Clean up all experiments in this workspace, skipping any in use',
    )
    .option(
      '--dry-run',
      'Preview eligible resources and reasons for retaining others',
    )
    .addHelpText(
      'after',
      '\nWith no ID or flags, cleanup previews the workspace. Checkpoints, results and logs are kept for --resume. Required images may be pulled or built again.',
    )
    .action(cleanup);
  program
    .command('catalog')
    .description('Show registered contracts, plugins, and policies')
    .action(() => runJson(({ registry }) => registry.catalog()));
  program
    .command('dashboard')
    .description('Start the dashboard (localhost by default)')
    .option(
      '--public-read-only',
      'Listen on all IPv4 interfaces for read-only access',
    )
    .option(
      '--port <port>',
      'Listening port (1..65535)',
      (value: string) => {
        const port = Number(value);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
          throw new InvalidArgumentError('port must be 1..65535');
        return port;
      },
      4317,
    )
    .action(startDashboard);
  const reflection = program
    .command('reflection')
    .description('Inspect and apply reflection revisions');
  reflection
    .command('list [experiment-id]')
    .description('List reflection revisions')
    .action(forRevision((revisions, id) => revisions.list(id)));
  reflection
    .command('show <revisionID>')
    .description('Show reflection revisions')
    .action(forRevision((revisions, id) => revisions.show(requireId(id))));
  reflection
    .command('apply <revisionID>')
    .description('Apply reflection revisions')
    .action(forRevision((revisions, id) => revisions.apply(requireId(id))));

  async function runJson(
    execute: (runtime: Runtime) => unknown,
  ): Promise<void> {
    const runtime = await context.openRuntime(
      program.opts<{ pluginDir: string[] }>().pluginDir,
    );
    result = {
      exitCode: 0,
      stdout: JSON.stringify(await execute(runtime), null, 2) + '\n',
    };
  }

  function runExperiment(
    file: string,
    { id, resume = false }: { id?: string; resume?: boolean },
    cmd: Command,
  ): Promise<void> {
    if (resume && !id) cmd.error('--resume requires --id');
    return runJson(({ manager }) =>
      manager.run(resolve(file), { id, resume, signal: context.signal }),
    );
  }

  async function runDoctorCommand(
    recipePath: string,
    options: { json?: boolean },
  ): Promise<void> {
    const { runDoctor } = await import('../../runtime/doctor/index.js');
    const report = await runDoctor(recipePath, {
      signal: context.signal,
      openRuntime: () =>
        context.openRuntime(program.opts<{ pluginDir: string[] }>().pluginDir),
      releaseRuntime: context.releaseRuntime,
    });
    result = {
      exitCode: report.checks.some(({ status }) => status === 'failed') ? 1 : 0,
      stdout: options.json
        ? JSON.stringify(report, null, 2) + '\n'
        : formatDoctorSummary(report, recipePath),
    };
  }

  function list(kind: string | undefined): Promise<void> {
    return runJson(async ({ manager, registry }) => {
      if (!kind) return manager.list();
      const { describeCatalog } = await import('./catalog.js');
      const catalog = await describeCatalog(registry);
      return kind === 'plugin' || kind === 'plugins'
        ? catalog.plugins
        : catalog.policies;
    });
  }

  function cancelExperiment(id: string): Promise<void> {
    return runJson(async ({ manager }) => {
      await manager.cancel(id);
      return { id, cancellationRequested: true };
    });
  }

  async function cleanup(
    id: string | undefined,
    { dryRun = false, all = false }: { dryRun?: boolean; all?: boolean },
    cmd: Command,
  ): Promise<void> {
    if (id !== undefined && all)
      cmd.error('--all cannot be combined with an experiment ID');
    const { manager } = await context.openRuntime(
      program.opts<{ pluginDir: string[] }>().pluginDir,
    );
    const { cleanupExperiment, cleanupWorkspace } = await import(
      './cleanup.js'
    );
    const report =
      id === undefined
        ? await cleanupWorkspace(manager, dryRun || !all, context.signal)
        : await cleanupExperiment(manager, id, dryRun, context.signal);
    const incomplete =
      'experiments' in report
        ? report.experiments.some(
            ({ status }) => status === 'pending' || status === 'failed',
          )
        : report.results.some(({ status }) => status === 'pending');
    result = {
      exitCode: context.signal.aborted ? 130 : incomplete ? 1 : 0,
      stdout: JSON.stringify(report, null, 2) + '\n',
    };
  }

  function forRevision(
    execute: (revisions: RevisionApplication, id?: string) => Promise<unknown>,
  ): (id?: string) => Promise<void> {
    return (id) =>
      runJson(({ manager }) => execute(manager.reflection(), id || undefined));
  }

  function requireId(id?: string): string {
    if (!id) throw new Error('Revision ID is required');
    return id;
  }

  async function startDashboard({
    port,
    publicReadOnly = false,
  }: {
    port: number;
    publicReadOnly?: boolean;
  }): Promise<void> {
    if (!statSync('.rsi', { throwIfNoEntry: false })?.isDirectory())
      throw new Error(
        'Dashboard requires a .rsi directory in the current working directory. Run it from your experiment workspace.',
      );
    const runtime = await context.openRuntime(
      program.opts<{ pluginDir: string[] }>().pluginDir,
    );
    const { createServer } = await import('../web/server.js');
    const server = await createServer(runtime, { publicReadOnly });
    const address = await server.listen({
      host: publicReadOnly ? '0.0.0.0' : '127.0.0.1',
      port,
    });
    process.stdout.write(
      publicReadOnly
        ? `Public read-only dashboard listening on 0.0.0.0:${port}\n`
        : `Dashboard open at ${address}\n`,
    );
    try {
      await aborted(context.signal, server);
    } finally {
      await server.close();
    }
  }

  try {
    await program.parseAsync(argv.length ? argv : ['--help'], { from: 'user' });
  } catch (error) {
    if (commanderExit === undefined || error !== commanderExit) throw error;
    return { exitCode: commanderExit.exitCode === 0 ? 0 : 2 };
  }
  return result;
}
