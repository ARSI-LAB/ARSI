import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { aborted } from 'node:util';
import {
  Argument,
  Command,
  InvalidArgumentError,
  Option,
  type CommanderError,
} from 'commander';
import type { Runtime } from '../../runtime/context.js';
import type { RevisionApplication } from '../../runtime/revisions/application.js';
import { startCleanupProgress } from './cleanup-progress.js';
import { startDoctorProgress } from './doctor-progress.js';
import { startRunProgress } from './run-progress.js';
import { errorText } from '../../shared/errors.js';
import {
  isInteractiveTTY,
  type ProgressMode,
  type ProgressStream,
} from './terminal-renderer.js';

export interface CommandContext {
  signal: AbortSignal;
  openRuntime(pluginDirectories: string[]): Promise<Runtime>;
  releaseRuntime(): Promise<void>;
  progressStream?: ProgressStream;
  onProgressErrorReported?(normalizedError: string): void;
}

interface CommandResult {
  exitCode: number;
  stdout?: string;
}

interface ProgressCliOptions {
  progress?: boolean;
  progressMode?: ProgressMode;
  verbose?: boolean;
  quiet?: boolean;
}

function addProgressOptions(cmd: Command, verboseDescription: string): Command {
  return cmd
    .option('--progress', 'Print live progress and a summary to stderr')
    .option('--no-progress', 'Disable live progress output on stderr')
    .addOption(
      new Option(
        '--progress-mode <mode>',
        'Set the progress renderer mode',
      ).choices(['auto', 'tty', 'plain']),
    )
    .option('-v, --verbose', verboseDescription)
    .option('-q, --quiet', 'Suppress live progress output on stderr');
}

function resolveProgressOptions(
  options: ProgressCliOptions,
  cmd: Command,
  stream: ProgressStream | undefined,
): { enabled: boolean; mode: ProgressMode; verbose: boolean } {
  const { progress, progressMode, verbose = false, quiet = false } = options;
  const progressSource = cmd.getOptionValueSource('progress');
  const progressExplicitOn = progressSource === 'cli' && progress === true;
  const progressExplicitOff = progressSource === 'cli' && progress === false;
  if (quiet && (progressExplicitOn || progressMode !== undefined || verbose)) {
    cmd.error(
      '--quiet cannot be combined with --progress, --progress-mode, or --verbose',
    );
  }
  if (progressExplicitOff && (progressMode !== undefined || verbose)) {
    cmd.error(
      '--no-progress cannot be combined with --progress-mode or --verbose',
    );
  }
  const enabled =
    stream !== undefined &&
    !quiet &&
    !progressExplicitOff &&
    (progressExplicitOn ||
      progressMode !== undefined ||
      verbose ||
      isInteractiveTTY(stream));
  return { enabled, mode: progressMode ?? 'auto', verbose };
}

export async function runCommand(
  argv: string[],
  context: CommandContext,
): Promise<CommandResult> {
  const { progressStream } = context;
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
  addProgressOptions(
    program
      .command('run <recipe.yaml>')
      .description('Run or resume an experiment')
      .option('--id <experiment-id>', 'Set the experiment ID')
      .option('--resume', 'Resume an experiment using a compatible Recipe'),
    'Include Policy steps and nested calls in progress output',
  ).action(runExperiment);
  addProgressOptions(
    program
      .command('doctor <recipe.yaml>')
      .description('Check experiment configuration and runtime prerequisites')
      .option('--static', 'Check configuration and declared local paths only'),
    'Include every individual check result in progress output',
  ).action(runDoctor);
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
  addProgressOptions(
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
      ),
    'Include bindings and individual receipt details in progress output',
  ).action(cleanup);
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

  async function runExperiment(
    file: string,
    options: { id?: string; resume?: boolean } & ProgressCliOptions,
    cmd: Command,
  ): Promise<void> {
    const { id, resume = false } = options;
    if (resume && !id) cmd.error('--resume requires --id');
    const resolved = resolveProgressOptions(options, cmd, progressStream);
    const reporter =
      progressStream && resolved.enabled
        ? startRunProgress({
            stream: progressStream,
            recipe: file,
            id,
            resume,
            mode: resolved.mode,
            verbose: resolved.verbose,
            onErrorReported: context.onProgressErrorReported,
          })
        : undefined;
    let succeeded = false;
    try {
      await runJson(({ manager }) =>
        manager.run(resolve(file), {
          id,
          resume,
          signal: context.signal,
          ...(reporter && { onProgress: reporter.observe }),
        }),
      );
      succeeded = true;
    } finally {
      reporter?.finish(
        succeeded
          ? 'succeeded'
          : context.signal.aborted
            ? 'cancelled'
            : 'failed',
      );
    }
  }

  async function runDoctor(
    file: string,
    options: { static?: boolean } & ProgressCliOptions,
    cmd: Command,
  ): Promise<void> {
    const resolved = resolveProgressOptions(options, cmd, progressStream);
    const reporter =
      progressStream && resolved.enabled
        ? startDoctorProgress({
            stream: progressStream,
            recipe: file,
            staticOnly: options.static ?? false,
            mode: resolved.mode,
            verbose: resolved.verbose,
          })
        : undefined;
    let completed = false;
    try {
      const { checkRecipe } = await import(
        '../../runtime/doctor/check-recipe.js'
      );
      const report = await checkRecipe(file, {
        signal: context.signal,
        staticOnly: options.static ?? false,
        openRuntime,
        releaseRuntime: context.releaseRuntime,
        ...(reporter && { onProgress: reporter.observe }),
      });
      completed = true;
      result = { exitCode: report.summary.failed > 0 ? 1 : 0, json: report };
    } finally {
      reporter?.finish(
        completed
          ? 'completed'
          : context.signal.aborted
            ? 'cancelled'
            : 'failed',
      );
    }
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
    options: { dryRun?: boolean; all?: boolean } & ProgressCliOptions,
    cmd: Command,
  ): Promise<void> {
    const { dryRun = false, all = false } = options;
    if (id !== undefined && all)
      cmd.error('--all cannot be combined with an experiment ID');
    const resolved = resolveProgressOptions(options, cmd, progressStream);
    const effectiveDryRun = id === undefined ? dryRun || !all : dryRun;
    const reporter =
      progressStream && resolved.enabled
        ? startCleanupProgress({
            stream: progressStream,
            scope: id === undefined ? 'workspace' : 'experiment',
            experimentId: id,
            dryRun: effectiveDryRun,
            mode: resolved.mode,
            verbose: resolved.verbose,
            onErrorReported: context.onProgressErrorReported,
          })
        : undefined;
    let completed = false;
    let failureError: string | undefined;
    try {
      const { manager } = await openRuntime();
      const { cleanupExperiment, cleanupWorkspace } = await import(
        './cleanup.js'
      );
      const report =
        id === undefined
          ? await cleanupWorkspace(
              manager,
              effectiveDryRun,
              context.signal,
              reporter?.observe,
            )
          : await cleanupExperiment(
              manager,
              id,
              effectiveDryRun,
              context.signal,
              reporter?.observe,
            );
      const incomplete =
        'experiments' in report
          ? report.experiments.some(
              ({ status }) => status === 'pending' || status === 'failed',
            )
          : report.results.some(({ status }) => status === 'pending');
      completed = true;
      result = {
        exitCode: context.signal.aborted ? 130 : incomplete ? 1 : 0,
        json: report,
      };
    } catch (error) {
      failureError = errorText(error);
      throw error;
    } finally {
      reporter?.finish(
        context.signal.aborted
          ? 'cancelled'
          : completed
            ? 'completed'
            : 'failed',
        failureError,
      );
    }
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
