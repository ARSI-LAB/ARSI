import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Argument,
} from 'commander';

interface ParsedCommand {
  command: string;
  args: string[];
  pluginDirectories: string[];
  id?: string;
  resume?: boolean;
  port?: number;
  help?: string;
}

export function parseCommand(argv: string[]): ParsedCommand {
  let result: ParsedCommand | undefined;
  let help = '';
  const program = new Command('ember-rsi')
    .description('Make everything rsi-able')
    .option(
      '--plugin-dir <directory>',
      'Load extensions from a directory (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        help += text;
      },
      writeErr: () => {},
    })
    .showHelpAfterError();
  program.addHelpText(
    'after',
    '\nRun facts are saved in .rsi/ under the current directory.\nExtensions load from ~/.ember-rsi/plugins/<name>/index.mjs by default.\nEach plugin directory must contain index.mjs exporting register(registry).',
  );
  const capture = (command: string, args: string[], cmd: Command): void => {
    result = {
      command,
      args,
      pluginDirectories: program.opts<{ pluginDir: string[] }>().pluginDir,
    };
    if (command === 'run') {
      const opts = cmd.opts<{ id?: string; resume?: boolean }>();
      if (opts.resume && !opts.id) throw new Error('--resume requires --id');
      result.id = opts.id;
      result.resume = opts.resume ?? false;
    }
    if (command === 'serve') result.port = cmd.opts<{ port: number }>().port;
  };
  program
    .command('run <recipe.yaml>')
    .description('Run or resume an experiment')
    .option('--id <experiment-id>', 'Set the experiment ID')
    .option('--resume', 'Resume the experiment specified by --id')
    .action((file: string, _opts: unknown, cmd: Command) =>
      capture('run', [file], cmd),
    );
  program
    .command('validate <recipe.yaml>')
    .description('Validate a recipe')
    .action((file: string, _opts: unknown, cmd: Command) =>
      capture('validate', [file], cmd),
    );
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
    .action((kind: string | undefined, _opts: unknown, cmd: Command) =>
      capture('list', kind ? [kind] : [], cmd),
    );
  for (const name of ['show', 'cancel']) {
    program
      .command(`${name} <experiment-id>`)
      .description(`${name === 'show' ? 'Show' : 'Cancel'} an experiment`)
      .action((id: string, _opts: unknown, cmd: Command) =>
        capture(name, [id], cmd),
      );
  }
  const reflection = program
    .command('reflection')
    .description('Inspect and apply reflection revisions');
  for (const name of ['list', 'show', 'apply']) {
    reflection
      .command(
        `${name} ${name === 'list' ? '[experiment-id]' : '<revisionID>'}`,
      )
      .description(
        `${name === 'list' ? 'List' : name === 'show' ? 'Show' : 'Apply'} reflection revisions`,
      )
      .action((id: string | undefined, _opts: unknown, cmd: Command) =>
        capture('reflection', id ? [name, id] : [name], cmd),
      );
  }
  program
    .command('catalog')
    .description('Show registered contracts, plugins, and policies')
    .action((_opts: unknown, cmd: Command) => capture('catalog', [], cmd));
  program
    .command('serve')
    .description('Serve the Web UI on localhost')
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
    .action((_opts: unknown, cmd: Command) => capture('serve', [], cmd));
  const configure = (cmd: Command): void => {
    cmd.exitOverride().allowExcessArguments(false);
    for (const child of cmd.commands) configure(child);
  };
  configure(program);
  try {
    program.parse(argv.length ? argv : ['--help'], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0)
      return { command: 'help', args: [], pluginDirectories: [], help };
    throw error;
  }
  if (!result)
    throw new Error('Choose a subcommand; use --help for available commands');
  return result;
}
