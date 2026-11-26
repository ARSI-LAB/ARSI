import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import type { CommandContext, CommandOptions } from '../commands.js';
import { configureCliLogging } from '../logging/index.js';

export interface CliSession extends Pick<CommandContext, 'openShell'> {
  dispatch: NonNullable<CommandContext['dispatch']>;
  dispose(): void;
}

export function createCliSession(
  signal: AbortSignal,
  run: (argv: string[], options: CommandOptions) => Promise<number>,
): CliSession {
  const ci = process.env.CI?.toLowerCase();
  const interactive =
    Boolean(
      process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY,
    ) &&
    (!ci || ci === '0' || ci === 'false');
  const logging = configureCliLogging(interactive);
  const session: CliSession = {
    async dispatch(command, options, action, experimentId) {
      const execute = () =>
        logging.run(options, action, { command, experimentId });
      if (!interactive || options.quiet) return execute();
      const { runWithSpinner } = await import('./task-runner.js');
      return runWithSpinner(logging, execute);
    },
    dispose: () => logging.dispose(),
  };
  if (interactive)
    session.openShell = async (options) => {
      const { runInteractive } = await import('./interactive.js');
      return runInteractive({
        options,
        signal,
        version: cliVersion(),
        workspace: process.cwd(),
        run,
      });
    };
  return session;
}

function cliVersion(): string {
  const path = findPackageJSON(import.meta.url);
  if (!path) return 'unknown';
  const { version }: { version?: unknown } = JSON.parse(
    readFileSync(path, 'utf8'),
  );
  return typeof version === 'string' ? version : 'unknown';
}
