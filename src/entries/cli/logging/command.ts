import { getLogger } from '@logtape/logtape';
import type { Command } from 'commander';
import type { FastifyInstance } from 'fastify';
import type { DoctorReport } from '../../../contracts/index.js';
import { formatDuration } from '../../../shared/call-log.js';
import { RuntimeCleanupInterruptedError } from '../../../shared/errors.js';
import type {
  CommandContext,
  CommandOptions,
  CommandResult,
} from '../commands.js';
import {
  cliLogger,
  currentExperimentId,
  logDiagnostic,
  parseLogLevels,
} from './index.js';

const webLogger = getLogger(['arsi', 'web']);
const doctorLogger = getLogger(['arsi', 'runtime', 'doctor']);

export function addLogOptions(
  program: Command,
  defaults?: CommandOptions,
): () => CommandOptions {
  program
    .option(
      '--log-level <level|category=level>',
      'Set the log level or override a dotted log category (repeatable)',
      parseLogLevels,
      defaults?.logLevel,
    )
    .option('--log-file <path>', 'Append logs to a file', defaults?.logFile)
    .option('--no-log-file', 'Disable file logging')
    .option(
      '-q, --quiet',
      'Show only errors and command output',
      defaults?.quiet,
    );

  let noLogFileRequested = false;
  program.on('option:no-log-file', () => {
    noLogFileRequested = true;
  });

  return function readLogOptions(): CommandOptions {
    const { logFile, ...options } = program.opts<
      Omit<CommandOptions, 'logFile'> & { logFile?: string | boolean }
    >();
    return {
      ...options,
      noLogFile:
        noLogFileRequested ||
        (program.getOptionValueSource('logFile') !== 'cli' &&
          defaults?.noLogFile),
      logFile: typeof logFile === 'string' ? logFile : undefined,
    };
  };
}

export function logDoctorChecks(report: DoctorReport): void {
  for (const { id: checkId, status, reason } of report.checks) {
    const fields = {
      checkId,
      reason: reason ? ': ' + reason : '',
      inResult: true,
    };
    if (status === 'failed')
      doctorLogger.error('{checkId}{reason}', { ...fields, stage: 'Failed' });
    else if (status === 'passed')
      doctorLogger.info('{checkId}', { ...fields, stage: 'Passed' });
    else
      doctorLogger.debug('{checkId}{reason}', {
        ...fields,
        stage: 'Skipped',
      });
  }
}

export function attachWebLogging(server: FastifyInstance): void {
  server.addHook('onResponse', async (request, reply) => {
    webLogger.info('{method} {path} -> {statusCode} ({elapsedMs}ms)', {
      method: request.method,
      path: request.url.split('?', 1)[0],
      statusCode: reply.statusCode,
      elapsedMs: Math.round(reply.elapsedTime),
    });
  });
  server.addHook('onError', async (request, _reply, error) => {
    webLogger.error('{method} {path}: {summary}', {
      method: request.method,
      path: request.url.split('?', 1)[0],
      summary: error.message,
      error,
    });
  });
}

export function logDashboardListening(
  address: string,
  port: number,
  publicReadOnly: boolean,
): void {
  if (publicReadOnly)
    webLogger.info('Public read-only dashboard listening on 0.0.0.0:{port}', {
      port,
    });
  else webLogger.info('Dashboard open at {address}', { address });
}

type ReportDiagnostic = (error: unknown, prefix?: string) => void;

export function reportCommandFailure(
  error: unknown,
  aborted: boolean,
  report: ReportDiagnostic,
): number {
  if (error instanceof RuntimeCleanupInterruptedError) {
    report(error.interruption);
    report(error.cause, 'Failed to dispose runtime: ');
  } else report(error);
  return aborted ? 130 : 1;
}

export async function releaseCommandRuntime(
  context: Pick<CommandContext, 'releaseRuntime'>,
  exitCode: number,
  report: ReportDiagnostic,
): Promise<number> {
  try {
    await context.releaseRuntime();
    return exitCode;
  } catch (error) {
    report(error, 'Failed to dispose runtime: ');
    return exitCode || 1;
  }
}

export async function executeWithLogging(
  target: string,
  context: CommandContext,
  execute: () => Promise<CommandResult>,
): Promise<CommandResult> {
  const start = performance.now();
  const id = currentExperimentId();
  cliLogger.info('{target}', {
    stage: 'Starting',
    target: id ? `${target} (${id})` : target,
  });
  let result: CommandResult = { exitCode: 0 };
  try {
    result = await execute();
  } catch (error) {
    result = {
      exitCode: reportCommandFailure(
        error,
        context.signal.aborted,
        logDiagnostic,
      ),
    };
  } finally {
    result.exitCode = await releaseCommandRuntime(
      context,
      result.exitCode,
      logDiagnostic,
    );
  }
  const durationMs = performance.now() - start;
  const status =
    result.exitCode === 0
      ? 'succeeded'
      : result.exitCode === 130
        ? 'cancelled'
        : 'failed';
  cliLogger.info('{target} {status} in {duration}', {
    stage: 'Finished',
    target: currentExperimentId() ?? target,
    status,
    exitCode: result.exitCode,
    durationMs,
    duration: formatDuration(durationMs),
  });
  return result;
}
