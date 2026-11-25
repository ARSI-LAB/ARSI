#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { constants } from 'node:os';
import type { Runtime } from '../../runtime/context.js';
import { RuntimeCleanupInterruptedError } from '../../shared/errors.js';
import {
  runCommand,
  type CommandContext,
  type CommandOptions,
} from './commands.js';
import { formatLogError } from './log-text.js';
import { configureCliLogging, runtimeLogger } from './logging.js';

async function main(argv: string[]): Promise<number> {
  const ci = process.env.CI?.toLowerCase();
  const interactive =
    Boolean(
      process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY,
    ) &&
    (!ci || ci === '0' || ci === 'false');
  const controller = new AbortController();
  const logging = configureCliLogging(interactive);
  const abort = (signal: NodeJS.Signals = 'SIGINT'): void => {
    if (controller.signal.aborted)
      process.exit(128 + constants.signals[signal]);
    controller.abort(new Error('Interrupted'));
  };
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    return await run(argv, controller.signal);
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    logging.dispose();
  }

  async function run(
    args: string[],
    signal: AbortSignal,
    defaults?: CommandOptions,
  ): Promise<number> {
    let exitCode = 0;
    let runtime: Runtime | undefined;
    const context: CommandContext = {
      signal,
      defaults,
      async openRuntime(pluginDirectories) {
        runtimeLogger.debug('Opening runtime');
        const { createRuntime } = await import('../../runtime/context.js');
        runtime = await createRuntime({ pluginDirectories });
        runtimeLogger.debug('Runtime ready');
        return runtime;
      },
      async releaseRuntime() {
        if (!runtime) return;
        const current = runtime;
        runtime = undefined;
        runtimeLogger.trace('Disposing runtime');
        await current.dispose();
      },
      async dispatch(command, options, action, experimentId) {
        const execute = () =>
          logging.run(options, action, { command, experimentId });
        if (!interactive || options.quiet) return execute();
        const { runWithSpinner } = await import('./task-runner.js');
        return runWithSpinner(logging, execute);
      },
    };
    if (interactive && !defaults) {
      context.openShell = async (options) => {
        const { runInteractive } = await import('./interactive.js');
        return runInteractive({
          options,
          signal,
          version: cliVersion(),
          workspace: process.cwd(),
          run: (words, defaults) => run(words, signal, defaults),
        });
      };
    }
    try {
      const result = await runCommand(args, context);
      if (result.stdout !== undefined) process.stdout.write(result.stdout);
      exitCode = result.exitCode;
    } catch (error) {
      if (error instanceof RuntimeCleanupInterruptedError) {
        process.stderr.write(formatLogError(error.interruption) + '\n');
        process.stderr.write(
          'Failed to dispose runtime: ' + formatLogError(error.cause) + '\n',
        );
      } else process.stderr.write(formatLogError(error) + '\n');
      exitCode = signal.aborted ? 130 : 1;
    } finally {
      try {
        await context.releaseRuntime();
      } catch (error) {
        process.stderr.write(
          'Failed to dispose runtime: ' + formatLogError(error) + '\n',
        );
        exitCode ||= 1;
      }
    }
    return exitCode;
  }
}

function cliVersion(): string {
  const path = findPackageJSON(import.meta.url);
  if (!path) return 'unknown';
  const { version }: { version?: unknown } = JSON.parse(
    readFileSync(path, 'utf8'),
  );
  return typeof version === 'string' ? version : 'unknown';
}

process.exitCode = await main(process.argv.slice(2));
