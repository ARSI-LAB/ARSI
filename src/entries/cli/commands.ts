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
  let result: { exitCode: number; json?: unknown } | undefined;
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
  const openRuntime = (): Promise<Runtime> =>
    context.openRuntime(program.opts<{ pluginDir: string[] }>().pluginDir);
  const runJson = async (
    execute: (runtime: Runtime) => unknown,
  ): Promise<void> => {
    const runtime = await openRuntime();
    result = { exitCode: 0, json: await execute(runtime) };
  };
  program
    .command('run <recipe.yaml>')
    .description('Run or resume an experiment')
    .option('--id <experiment-id>', 'Set the experiment ID')
    .option('--resume', 'Resume an experiment using a compatible Recipe')
    .action(runExperiment);
  program
    .command('doctor <recipe.yaml>')
    .description('Check experiment configuration and runtime prerequisites')
    .option('--static', 'Check configuration and declared local paths only')
    .action(runDoctor);
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
    .action((id: string) => runJson(({ manager }) => manager.get(id)));
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
    .command('catalog')
    .description('Show registered contracts, plugins, and policies')
    .action(() => runJson(({ registry }) => registry.catalog()));
  program
    .command('dashboard')
    .description('Start the dashboard on localhost')
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

  async function runDoctor(
    file: string,
    options: { static?: boolean },
  ): Promise<void> {
    const { checkRecipe } = await import(
      '../../runtime/doctor/check-recipe.js'
    );
    const report = await checkRecipe(file, {
      signal: context.signal,
      staticOnly: options.static ?? false,
      openRuntime,
      releaseRuntime: context.releaseRuntime,
    });
    result = { exitCode: report.summary.failed > 0 ? 1 : 0, json: report };
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
    result = {
      exitCode: context.signal.aborted ? 130 : incomplete ? 1 : 0,
      json: report,
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

  async function startDashboard({ port }: { port: number }): Promise<void> {
    if (!statSync('.rsi', { throwIfNoEntry: false })?.isDirectory())
      throw new Error(
        'Dashboard requires a .rsi directory in the current working directory. Run it from your experiment workspace.',
      );
    const runtime = await openRuntime();
    const { createServer } = await import('../web/server.js');
    const server = await createServer(runtime);
    const address = await server.listen({ host: '127.0.0.1', port });
    process.stdout.write(`Dashboard open at ${address}\n`);
    try {
      await aborted(context.signal, server);
    } finally {
      await server.close();
    }
    result = { exitCode: 0 };
  }

  try {
    await program.parseAsync(argv.length ? argv : ['--help'], { from: 'user' });
  } catch (error) {
    if (commanderExit === undefined || error !== commanderExit) throw error;
    return { exitCode: commanderExit.exitCode === 0 ? 0 : 2 };
  }
  if (!result)
    throw new Error('Choose a subcommand; use --help for available commands');
  if ('json' in result)
    return {
      exitCode: result.exitCode,
      stdout: JSON.stringify(result.json, null, 2) + '\n',
    };
  return result;
}
