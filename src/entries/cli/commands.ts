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
import { formatDoctorSummary } from '../../runtime/doctor/report.js';
import type { RevisionApplication } from '../../runtime/revisions/application.js';
import {
  addLogOptions,
  attachWebLogging,
  executeWithLogging,
  logDashboardListening,
  logDoctorChecks,
} from './logging/command.js';
import type { LogOptions } from './logging/index.js';

export interface CommandOptions extends LogOptions {
  pluginDir: string[];
}

export interface CommandContext {
  signal: AbortSignal;
  openRuntime(pluginDirectories: string[]): Promise<Runtime>;
  releaseRuntime(): Promise<void>;
  defaults?: CommandOptions;
  writeOut?(text: string): void;
  writeErr?(text: string): void;
  dispatch?(
    name: string,
    options: CommandOptions,
    execute: () => Promise<CommandResult>,
    experimentId?: string,
  ): Promise<CommandResult>;
  openShell?(options: CommandOptions): Promise<number>;
}

export interface CommandResult {
  exitCode: number;
  stdout?: string;
}

export async function runCommand(
  argv: string[],
  context: CommandContext,
): Promise<CommandResult> {
  let result: CommandResult | undefined;
  let commanderExit: CommanderError | undefined;
  const writeOut =
    context.writeOut ??
    ((text) => {
      process.stdout.write(text);
    });
  const writeErr =
    context.writeErr ??
    ((text) => {
      process.stderr.write(text);
    });
  const program = new Command('arsi')
    .description('Make everything rsi-able')
    .allowExcessArguments(false)
    .showHelpAfterError()
    .configureOutput({ writeOut, writeErr })
    .exitOverride((error) => {
      commanderExit = error;
      throw error;
    })
    .option(
      '--plugin-dir <directory>',
      'Load extensions from a directory (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      context.defaults?.pluginDir ?? [],
    )
    .addHelpText(
      'after',
      '\nRun facts are saved in .rsi/ under the current directory.\nExtensions load from ~/.arsi/plugins/<name>/index.mjs by default.\nEach plugin directory must contain index.mjs exporting register(registry).',
    );
  const commandOptions = addLogOptions(program, context.defaults);

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
    .action((id: string, options: { checkpoint?: boolean }, command: Command) =>
      runJson(command, ({ manager }) => manager.get(id, options)),
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
    .action((_options: unknown, command: Command) =>
      runJson(command, ({ registry }) => registry.catalog()),
    );
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
  program
    .command('shell')
    .description('Open the interactive CLI')
    .action(openShell);

  function openRuntime(): Promise<Runtime> {
    return context.openRuntime(commandOptions().pluginDir);
  }

  function runJson(
    command: Command,
    execute: (runtime: Runtime) => unknown,
  ): Promise<void> {
    return runAction(command, async () => {
      const runtime = await openRuntime();
      return {
        exitCode: 0,
        stdout: JSON.stringify(await execute(runtime), null, 2) + '\n',
      };
    });
  }

  async function runAction(
    command: Command,
    execute: () => Promise<CommandResult>,
  ): Promise<void> {
    if (!context.dispatch) {
      result = await execute();
      return;
    }
    const name = commandPath(command);
    const experimentId =
      name === 'run' ? command.opts<{ id?: string }>().id : undefined;
    const target = name === 'run' ? command.args[0] : name;
    result = await context.dispatch(
      name,
      commandOptions(),
      () => executeWithLogging(target, context, execute),
      experimentId,
    );
  }

  function runExperiment(
    file: string,
    { id, resume = false }: { id?: string; resume?: boolean },
    command: Command,
  ): Promise<void> {
    if (resume && !id) command.error('--resume requires --id');
    return runJson(command, async ({ manager }) => {
      const { executeRun } = await import('./run/index.js');
      return executeRun(manager, resolve(file), {
        id,
        resume,
        signal: context.signal,
        logging: context.dispatch !== undefined,
      });
    });
  }

  function runDoctorCommand(
    recipePath: string,
    { json = false }: { json?: boolean },
    command: Command,
  ): Promise<void> {
    return runAction(command, async () => {
      const { runDoctor } = await import('../../runtime/doctor/index.js');
      const report = await runDoctor(recipePath, {
        signal: context.signal,
        openRuntime,
        releaseRuntime: context.releaseRuntime,
      });
      logDoctorChecks(report);
      return {
        exitCode: report.checks.some(({ status }) => status === 'failed')
          ? 1
          : 0,
        stdout: json
          ? JSON.stringify(report, null, 2) + '\n'
          : formatDoctorSummary(report, recipePath),
      };
    });
  }

  function list(
    kind: string | undefined,
    _options: unknown,
    command: Command,
  ): Promise<void> {
    return runJson(command, async ({ manager, registry }) => {
      if (!kind) return manager.list();
      const { describeCatalog } = await import('./catalog.js');
      const catalog = await describeCatalog(registry);
      return kind === 'plugin' || kind === 'plugins'
        ? catalog.plugins
        : catalog.policies;
    });
  }

  function cancelExperiment(
    id: string,
    _options: unknown,
    command: Command,
  ): Promise<void> {
    return runJson(command, async ({ manager }) => {
      await manager.cancel(id);
      return { id, cancellationRequested: true };
    });
  }

  function cleanup(
    id: string | undefined,
    { dryRun = false, all = false }: { dryRun?: boolean; all?: boolean },
    command: Command,
  ): Promise<void> {
    if (id !== undefined && all)
      command.error('--all cannot be combined with an experiment ID');
    return runAction(command, async () => {
      const { manager } = await openRuntime();
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
      return {
        exitCode: context.signal.aborted ? 130 : incomplete ? 1 : 0,
        stdout: JSON.stringify(report, null, 2) + '\n',
      };
    });
  }

  function forRevision(
    execute: (revisions: RevisionApplication, id?: string) => Promise<unknown>,
  ): (
    id: string | undefined,
    options: unknown,
    command: Command,
  ) => Promise<void> {
    return (id, _options, command) =>
      runJson(command, ({ manager }) =>
        execute(manager.reflection(), id || undefined),
      );
  }

  function requireId(id?: string): string {
    if (!id) throw new Error('Revision ID is required');
    return id;
  }

  function startDashboard(
    {
      port,
      publicReadOnly = false,
    }: { port: number; publicReadOnly?: boolean },
    command: Command,
  ): Promise<void> {
    return runAction(command, async () => {
      if (!statSync('.rsi', { throwIfNoEntry: false })?.isDirectory())
        throw new Error(
          'Dashboard requires a .rsi directory in the current working directory. Run it from your experiment workspace.',
        );
      const runtime = await openRuntime();
      const { createServer } = await import('../web/server.js');
      const server = await createServer(runtime, { publicReadOnly });
      attachWebLogging(server);
      try {
        const address = await server.listen({
          host: publicReadOnly ? '0.0.0.0' : '127.0.0.1',
          port,
        });
        logDashboardListening(address, port, publicReadOnly);
        await aborted(context.signal, server);
      } finally {
        await server.close();
      }
      return { exitCode: 0 };
    });
  }

  async function openShell(_options: unknown, command: Command): Promise<void> {
    if (!context.openShell)
      command.error(
        context.defaults
          ? 'Already in the interactive CLI'
          : 'The interactive CLI requires a terminal outside CI',
      );
    result = { exitCode: await context.openShell(commandOptions()) };
  }

  try {
    await program.parseAsync(
      argv.length ? argv : [context.openShell ? 'shell' : '--help'],
      { from: 'user' },
    );
  } catch (error) {
    if (commanderExit === undefined || error !== commanderExit) throw error;
    return { exitCode: commanderExit.exitCode === 0 ? 0 : 2 };
  }
  if (!result)
    throw new Error('Choose a subcommand; use --help for available commands');
  return result;
}

function commandPath(command: Command): string {
  return command.parent?.parent
    ? `${commandPath(command.parent)} ${command.name()}`
    : command.name();
}
