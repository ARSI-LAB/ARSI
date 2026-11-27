import { isCancel, select, text } from '@clack/prompts';
import { renderBanner } from './banner.js';
import type { CommandOptions } from '../commands.js';
import { parseLogLevels, terminalLogLevel } from '../logging/index.js';
import { formatLogError } from '../logging/log-text.js';
import { parseShellLine, shellHelp } from './shell-parser.js';

const choices = [
  {
    value: 'run',
    label: 'Run',
    placeholder: '"path/to/recipe.yaml" [--id ID] [--resume]',
  },
  {
    value: 'doctor',
    label: 'Doctor',
    placeholder: '"path/to/recipe.yaml" [--json]',
  },
  {
    value: 'list',
    label: 'List',
    placeholder: 'plugins or policies (optional)',
  },
  { value: 'show', label: 'Show', placeholder: 'experiment-id' },
  {
    value: 'cleanup',
    label: 'Cleanup',
    placeholder: '[experiment-id] [--dry-run]',
  },
  {
    value: 'memory',
    label: 'Memory',
    placeholder:
      'list [experiment-id] or show/apply <versionID> [--to <directory>]',
  },
  {
    value: 'reflection',
    label: 'Reflection',
    placeholder:
      'list [experiment-id] or show/apply <revisionID> [--to <directory>]',
  },
  {
    value: 'dashboard',
    label: 'Dashboard',
    placeholder: '--port 4317 (optional)',
  },
  {
    value: 'log-level',
    label: 'Change log level',
    placeholder: 'debug or cli.runtime=trace',
  },
  {
    value: 'custom',
    label: 'Run custom CLI command',
    placeholder: 'arsi catalog',
  },
] as const;

interface InteractiveOptions {
  options: CommandOptions;
  signal: AbortSignal;
  version: string;
  workspace: string;
  run(argv: string[], options: CommandOptions): Promise<number>;
}

export async function runInteractive({
  options,
  signal,
  version,
  workspace,
  run,
}: InteractiveOptions): Promise<number> {
  const output = process.stderr;
  const printBanner = (): void => {
    const level = terminalLogLevel(options, true);
    // Interactive mode treats CI=0 and CI=false as a regular terminal.
    const terminalEnv = { ...process.env };
    delete terminalEnv.CI;
    output.write(
      renderBanner({
        version,
        workspace,
        level,
        columns: output.columns,
        color: !terminalEnv.NO_COLOR && output.hasColors?.(256, terminalEnv),
      }) + '\n',
    );
  };
  printBanner();
  while (!signal.aborted) {
    const choice = await select({
      message: 'Choose a command',
      options: [
        ...choices.map(({ value, label }) => ({ value, label })),
        { value: 'exit', label: 'Exit' },
      ],
      output,
      signal,
    });
    if (isCancel(choice) || choice === 'exit') break;
    const selected = choices.find(({ value }) => value === choice);
    const args = await text({
      message:
        choice === 'custom'
          ? 'Command'
          : choice === 'log-level'
            ? 'Log level'
            : `${selected?.label} arguments`,
      placeholder: selected?.placeholder,
      output,
      signal,
    });
    if (isCancel(args)) continue;
    try {
      const parsed = parseShellLine(
        choice === 'custom' ? args : `${choice} ${args}`,
      );
      if (parsed.kind === 'empty') continue;
      if (parsed.kind === 'command') {
        await run(parsed.argv, options);
        continue;
      }
      if (parsed.name === 'help') {
        if (!parsed.args.length) output.write(`${shellHelp}\n`);
        await run([...parsed.args, '--help'], options);
        continue;
      }
      if (parsed.args.length > (parsed.name === 'log-level' ? 1 : 0))
        throw new Error(
          `Usage: ${parsed.name}${parsed.name === 'log-level' ? ' [level|category=level]' : ''}`,
        );
      if (parsed.name === 'exit') break;
      if (parsed.name === 'clear') {
        output.write('\x1b[2J\x1b[3J\x1b[H');
        printBanner();
      } else {
        const [level] = parsed.args;
        if (level !== undefined)
          options.logLevel = parseLogLevels(level, options.logLevel);
        output.write(`Log level ${terminalLogLevel(options, true)}\n`);
        for (const [module, level] of options.logLevel?.modules ?? [])
          output.write(`${module}=${level}\n`);
      }
    } catch (error) {
      output.write(formatLogError(error) + '\n');
    }
  }
  return signal.aborted ? 130 : 0;
}
