#!/usr/bin/env node
import { constants } from 'node:os';
import type { Runtime } from '../../runtime/context.js';
import {
  runCommand,
  type CommandContext,
  type CommandOptions,
} from './commands.js';
import {
  releaseCommandRuntime,
  reportCommandFailure,
} from './logging/command.js';
import { runtimeLogger } from './logging/index.js';
import { formatLogError } from './logging/log-text.js';
import { createCliSession, type CliSession } from './ui/session.js';

async function main(argv: string[]): Promise<number> {
  const controller = new AbortController();
  const { signal } = controller;
  const session: CliSession = createCliSession(signal, (args, defaults) =>
    execute(args, signal, session, defaults),
  );
  const abort = (signal: NodeJS.Signals = 'SIGINT'): void => {
    if (controller.signal.aborted)
      process.exit(128 + constants.signals[signal]);
    controller.abort(new Error('Interrupted'));
  };
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    return await execute(argv, signal, session);
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    session.dispose();
  }
}

async function execute(
  argv: string[],
  signal: AbortSignal,
  session: CliSession,
  defaults?: CommandOptions,
): Promise<number> {
  let exitCode = 0;
  const context = createCommandContext(signal, session, defaults);
  try {
    const result = await runCommand(argv, context);
    if (result.stdout !== undefined) process.stdout.write(result.stdout);
    exitCode = result.exitCode;
  } catch (error) {
    exitCode = failCommand(error, signal.aborted);
  } finally {
    exitCode = await finishCommand(context, exitCode);
  }
  return exitCode;
}

function createCommandContext(
  signal: AbortSignal,
  session: CliSession,
  defaults?: CommandOptions,
): CommandContext {
  let runtime: Runtime | undefined;

  async function openRuntime(pluginDirectories: string[]): Promise<Runtime> {
    runtimeLogger.debug('Opening runtime');
    const { createRuntime } = await import('../../runtime/context.js');
    runtime = await createRuntime({ pluginDirectories });
    runtimeLogger.debug('Runtime ready');
    return runtime;
  }

  async function releaseRuntime(): Promise<void> {
    if (!runtime) return;
    const current = runtime;
    runtime = undefined;
    runtimeLogger.trace('Disposing runtime');
    await current.dispose();
  }

  return {
    signal,
    openRuntime,
    releaseRuntime,
    defaults,
    dispatch: session.dispatch,
    openShell: defaults ? undefined : session.openShell,
  };
}

function failCommand(error: unknown, aborted: boolean): number {
  return reportCommandFailure(error, aborted, writeDiagnostic);
}

function finishCommand(
  context: CommandContext,
  exitCode: number,
): Promise<number> {
  return releaseCommandRuntime(context, exitCode, writeDiagnostic);
}

function writeDiagnostic(error: unknown, prefix = ''): void {
  process.stderr.write(prefix + formatLogError(error) + '\n');
}

process.exitCode = await main(process.argv.slice(2));
