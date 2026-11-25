import { AsyncLocalStorage } from 'node:async_hooks';
import { closeSync, mkdirSync, openSync, statSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stripVTControlCharacters, styleText } from 'node:util';
import {
  compareLogLevel,
  configureSync,
  getLogger,
  getTextFormatter,
  resetSync,
  withContext,
  type LogLevel,
  type LogRecord,
} from '@logtape/logtape';
import { InvalidArgumentError } from 'commander';
import { safeId } from '../../runtime/storage/index.js';
import {
  selectionLogDetails,
  type SelectionLogDetails,
} from '../../shared/call-log.js';
import {
  formatLogError,
  formatErrorStack,
  redactEnvironment,
} from './log-text.js';

const levels = [
  'trace',
  'debug',
  'info',
  'warning',
  'error',
  'fatal',
  'off',
] as const;
type CliLogLevel = (typeof levels)[number];

export interface LogLevels {
  level?: CliLogLevel;
  modules?: ReadonlyMap<string, CliLogLevel>;
}

export interface LogOptions {
  logLevel?: LogLevels;
  logFile?: string;
  noLogFile?: boolean;
  quiet?: boolean;
}

export type TerminalMode = 'cargo' | 'spring' | 'plain';

export interface RunningTask {
  label: string;
  detail?: string;
  startedAt: number;
}

interface CargoCall {
  label: string;
  parentId?: string;
  reused?: boolean;
}

interface LogContext {
  command?: string;
  experimentId?: string;
  workspace?: string;
}

interface Invocation {
  command?: string;
  experimentId?: string;
  workspace: string;
  levels: LogLevels;
  quiet?: boolean;
  mode: TerminalMode;
  file?: { descriptor: number; path: string; hasRecords?: boolean };
  pending?: LogRecord[];
  usage?: LogRecord;
  failed?: boolean;
  preparedId?: string;
  tasks: Map<string, RunningTask>;
  calls: Map<string, CargoCall>;
  announcedParents: Set<string>;
  visibleParents: string[];
  callParents: Map<string, string>;
  fileErrors: Map<unknown, Set<string | undefined>>;
  terminalErrors: Map<unknown, Set<string | undefined>>;
  redact?: (message: string) => string;
  closed?: boolean;
}

const invocation = new AsyncLocalStorage<Invocation>();
export const cliLogger = getLogger(['arsi', 'cli']);
export const runtimeLogger = cliLogger.getChild('runtime');

export function parseLogLevels(
  value: string,
  previous: LogLevels = {},
): LogLevels {
  const separator = value.indexOf('=');
  const name = value
    .slice(separator + 1)
    .trim()
    .toLowerCase();
  const level = levels.find(
    (entry) => entry === (name === 'warn' ? 'warning' : name),
  );
  if (!level)
    throw new InvalidArgumentError(
      'Expected trace, debug, info, warn, error, fatal, or off',
    );
  if (separator < 0) return { ...previous, level };

  const category = value.slice(0, separator).trim();
  if (!/^[\w-]+(?:\.[\w-]+)*$/.test(category))
    throw new InvalidArgumentError('Expected a dot-separated log category');
  const path =
    category === 'arsi' || category.startsWith('arsi.')
      ? category
      : `arsi.${category}`;
  return { ...previous, modules: new Map(previous.modules).set(path, level) };
}

function configuredLevels(options: LogOptions): LogLevels {
  const global = process.env.ARSI_LOG_LEVEL?.trim();
  const overrides = process.env.ARSI_LOG_LEVELS?.split(',').filter((value) =>
    value.trim(),
  );
  let environment: LogLevels = {};
  if (options.logLevel?.level === undefined && global) {
    if (global.includes('='))
      throw new InvalidArgumentError(
        'ARSI_LOG_LEVEL requires a global log level',
      );
    environment = parseLogLevels(global);
  }
  for (const override of overrides ?? []) {
    if (!override.includes('='))
      throw new InvalidArgumentError(
        'ARSI_LOG_LEVELS requires comma-separated category=level entries',
      );
    environment = parseLogLevels(override, environment);
  }
  return {
    level: options.logLevel?.level ?? environment.level,
    modules: new Map([
      ...(environment.modules ?? []),
      ...(options.logLevel?.modules ?? []),
    ]),
  };
}

function moduleLevel(
  category: readonly string[],
  settings: LogLevels,
): CliLogLevel | undefined {
  for (let length = category.length; length > 0; length--) {
    const level = settings.modules?.get(category.slice(0, length).join('.'));
    if (level !== undefined) return level;
  }
  return undefined;
}

export function terminalLogLevel(
  options: LogOptions,
  interactive: boolean,
): CliLogLevel {
  return configuredLevels(options).level ?? (interactive ? 'info' : 'warning');
}

function terminalMode(
  command: string | undefined,
  settings: LogLevels,
  interactive: boolean,
  explicit: boolean,
): TerminalMode {
  if (
    command === 'dashboard' ||
    (!interactive && explicit) ||
    [settings.level, ...(settings.modules?.values() ?? [])].some(
      (level) => level === 'debug' || level === 'trace',
    )
  )
    return 'spring';
  return interactive ? 'cargo' : 'plain';
}

const labels: Record<LogLevel, string> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO',
  warning: 'WARN',
  error: 'ERROR',
  fatal: 'FATAL',
};

export const logLevelColors = {
  trace: 'gray',
  debug: 'blue',
  info: 'green',
  warning: 'yellow',
  error: 'red',
  fatal: 'magenta',
} as const satisfies Record<LogLevel, string>;

const formatMessage = getTextFormatter({
  format: ({ message }) => message,
  value: 'bare',
});

function cleanText(message: string): string {
  const redacted = redactEnvironment(stripVTControlCharacters(message));
  return (invocation.getStore()?.redact?.(redacted) ?? redacted)
    .replaceAll('\r\n', '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ');
}

function singleLine(message: string): string {
  return cleanText(message).replace(/\s+/g, ' ').trim();
}

function updateTasks(
  { calls, tasks }: Invocation,
  activeTask: unknown,
  timestamp: number,
  visible: boolean,
): boolean {
  if (
    !activeTask ||
    typeof activeTask !== 'object' ||
    !('id' in activeTask) ||
    typeof activeTask.id !== 'string'
  )
    return false;
  const { id } = activeTask;
  if ('done' in activeTask && activeTask.done === true) return tasks.delete(id);
  const detail =
    'detail' in activeTask && typeof activeTask.detail === 'string'
      ? singleLine(activeTask.detail)
      : undefined;
  const current = tasks.get(id);
  if (current) {
    if (!visible || detail === undefined || current.detail === detail)
      return false;
    tasks.set(id, { ...current, detail });
    return true;
  }
  if (!('label' in activeTask) || typeof activeTask.label !== 'string')
    return false;
  const call = {
    label: singleLine(activeTask.label),
    parentId:
      'parentId' in activeTask && typeof activeTask.parentId === 'string'
        ? activeTask.parentId
        : undefined,
  };
  calls.set(id, call);
  if (!visible) return false;
  tasks.set(id, {
    label: callBranch(calls, id)
      .map(({ label }) => label)
      .join(' → '),
    detail,
    startedAt: timestamp,
  });
  return true;
}

function callBranch(
  calls: ReadonlyMap<string, CargoCall>,
  id?: string,
): (CargoCall & { id: string })[] {
  const branch: (CargoCall & { id: string })[] = [];
  while (id && id !== 'root' && !branch.some((call) => call.id === id)) {
    const call = calls.get(id);
    if (!call) break;
    branch.push({ ...call, id });
    id = call.parentId;
  }
  return branch.reverse();
}

function body(record: LogRecord): string {
  return cleanText(formatMessage(record)).trimEnd();
}

function errorSummary(record: LogRecord): string | undefined {
  return 'error' in record.properties
    ? singleLine(formatLogError(record.properties.error))
    : undefined;
}

function terminalMessage(record: LogRecord, continuation: string): string {
  const message = singleLine(body(record));
  const summary = errorSummary(record);
  return summary && !message.includes(summary)
    ? `${message}${continuation}${summary}`
    : message;
}

export function logLineParts(record: LogRecord): {
  timestamp: string;
  level: string;
  context: string;
  category: string;
  message: string;
  stack?: string;
} {
  const date = new Date(record.timestamp);
  const local = new Date(record.timestamp - date.getTimezoneOffset() * 60_000);
  const { command, experimentId, stage } = record.properties;
  const context = experimentId ?? command;
  return {
    timestamp: local.toISOString().slice(0, -1).replace('T', ' '),
    level: labels[record.level].padStart(5),
    context: typeof context === 'string' ? singleLine(context) : '-',
    category: singleLine(record.category.join('.')).padEnd(20),
    message:
      typeof stage === 'string'
        ? `${singleLine(stage)} ${body(record)}`
        : body(record),
    stack:
      'error' in record.properties
        ? cleanText(formatErrorStack(record.properties.error))
        : undefined,
  };
}

export function formatLogLine(record: LogRecord, color = false): string {
  const { timestamp, level, context, category, message, stack } =
    logLineParts(record);
  const severity = color
    ? styleText(logLevelColors[record.level], level, { stream: process.stderr })
    : level;
  return `${timestamp} ${severity} ${process.pid} --- [${context}] ${category} : ${message}${stack ? `\n${stack}` : ''}\n`;
}

const stageColors = new Map<
  string,
  'cyan' | 'green' | 'yellow' | 'red' | 'gray'
>([
  ['Starting', 'cyan'],
  ['Preparing', 'cyan'],
  ['Running', 'cyan'],
  ['Progress', 'cyan'],
  ['Reused', 'cyan'],
  ['Activated', 'cyan'],
  ['Completed', 'green'],
  ['Passed', 'green'],
  ['Finished', 'green'],
  ['Warning', 'yellow'],
  ['Retrying', 'yellow'],
  ['Skipped', 'yellow'],
  ['Cancelled', 'yellow'],
  ['Error', 'red'],
  ['Failed', 'red'],
  ['Usage', 'gray'],
  ['Summary', 'gray'],
  ['Log', 'gray'],
  ['Info', 'gray'],
]);

export function formatSelection(details: SelectionLogDetails): string {
  const { accepted, metric, incumbentValue, candidateValue, selectedValue } =
    details;
  const decision = accepted ? 'accepted' : 'rejected';
  const comparison = `${decision} · ${metric} ${incumbentValue.toFixed(4)} → `;
  if (candidateValue === null) return `${comparison}unavailable`;
  const delta = candidateValue - incumbentValue;
  const kept =
    !accepted && candidateValue !== selectedValue
      ? ` · kept ${selectedValue.toFixed(4)}`
      : '';
  return `${comparison}${candidateValue.toFixed(4)} (${delta >= 0 ? '+' : ''}${delta.toFixed(4)})${kept}`;
}

export function formatCargoLine(
  record: LogRecord,
  stream: NodeJS.WritableStream = process.stderr,
): string {
  const {
    stage: explicit,
    status,
    cargoDepth,
    cargoHeaderOnly,
    cargoBreadcrumb,
    candidateRef,
    caseId,
    position,
    score,
    label,
    duration,
    selection,
  } = record.properties;
  const stage =
    typeof explicit === 'string' && stageColors.has(explicit)
      ? explicit
      : accepts(record.level, 'error')
        ? 'Error'
        : record.level === 'warning'
          ? 'Warning'
          : 'Info';
  const color =
    stage === 'Finished' && status === 'failed'
      ? 'red'
      : stage === 'Finished' && status === 'cancelled'
        ? 'yellow'
        : stageColors.get(stage)!;
  const depth =
    typeof cargoDepth === 'number' &&
    Number.isSafeInteger(cargoDepth) &&
    cargoDepth > 0
      ? cargoDepth
      : 0;
  let message = terminalMessage(
    record,
    stage === 'Failed' || stage === 'Cancelled' ? '\n' : ': ',
  );
  const decision =
    stage === 'Completed' ? selectionLogDetails(selection) : undefined;
  if (decision) {
    if (typeof label === 'string' && typeof duration === 'string')
      message = singleLine(`${label} ${duration}`);
    message += ` · ${singleLine(formatSelection(decision))}`;
  }
  if (
    stage === 'Progress' &&
    depth &&
    typeof caseId === 'string' &&
    typeof position === 'string' &&
    typeof status === 'string'
  )
    message = singleLine(
      `${position} ${caseId} ${status}${typeof score === 'string' ? score : ''}`,
    );
  if (
    typeof candidateRef === 'string' &&
    /^candidate-(?:[\da-f]{32}|[\da-f]{64})$/i.test(candidateRef)
  )
    message = message.replace(candidateRef, candidateRef.slice(0, 18));
  if (typeof cargoBreadcrumb === 'string')
    message = `${cargoBreadcrumb} → ${message}`;

  const showStage =
    cargoHeaderOnly !== true &&
    (!depth || !['Completed', 'Progress', 'Summary'].includes(stage));
  const paint = (text: string): string =>
    styleText(color === 'gray' ? 'dim' : ['bold', color], text, { stream });
  const prefix = depth
    ? `${' '.repeat(11 + 3 * (depth - 1))}├─ `
    : `${showStage ? paint(stage.padStart(10)) : ' '.repeat(10)} `;
  const childStage = depth && showStage ? `${paint(stage)} ` : '';
  return `${message ? prefix : prefix.trimEnd()}${childStage}${message.replaceAll('\n', '\n' + ' '.repeat(depth ? prefix.length : 11))}\n`;
}

function writeTerminal(
  record: LogRecord,
  mode: TerminalMode,
  write: (text: string) => void,
): void {
  if (mode === 'spring') write(formatLogLine(record, true));
  else if (mode === 'plain') {
    const prefix = record.properties.stage === 'Log' ? 'Log ' : '';
    write(`${prefix}${terminalMessage(record, ': ')}\n`);
  } else write(formatCargoLine(record));
}

/** Command errors are user-facing diagnostics even when logging is off. */
export function logDiagnostic(error: unknown, prefix = ''): void {
  cliLogger.error('{summary}', {
    stage: 'Error',
    error,
    summary: prefix + singleLine(formatLogError(error)),
    cliDiagnostic: true,
    diagnosticPrefix: prefix,
  });
}

export function currentExperimentId(): string | undefined {
  return invocation.getStore()?.experimentId;
}

export function currentPreparedRunId(): string | undefined {
  return invocation.getStore()?.preparedId;
}

export function setRunLogRedactor(redact: (message: string) => string): void {
  const scope = invocation.getStore();
  if (scope?.command === 'run' && !scope.closed) scope.redact = redact;
}

export function showsCargoRunDetails(): boolean {
  const scope = invocation.getStore();
  return (
    scope?.command === 'run' &&
    scope.mode === 'cargo' &&
    !scope.quiet &&
    accepts('info', terminalThreshold(scope, ['arsi', 'cli']))
  );
}

export interface CliLogging {
  run<T>(
    options: LogOptions,
    execute: () => Promise<T>,
    context?: LogContext,
  ): Promise<T>;
  takeTerminal(
    sink: (record: LogRecord, mode: TerminalMode) => void,
    onTask?: (task?: RunningTask) => void,
  ): () => void;
  dispose(): void;
}

function accepts(level: LogLevel, threshold: CliLogLevel): boolean {
  return threshold !== 'off' && compareLogLevel(level, threshold) >= 0;
}

function terminalThreshold(
  scope: Invocation,
  category: readonly string[],
): CliLogLevel {
  return moduleLevel(category, scope.levels) ?? scope.levels.level ?? 'info';
}

function validatedId(id?: string): string | undefined {
  if (id === undefined) return undefined;
  try {
    return safeId(id);
  } catch {
    return undefined; // Manager owns experiment ID validation.
  }
}

function withExperiment(record: LogRecord, scope: Invocation): LogRecord {
  if (
    scope.experimentId === undefined ||
    record.properties.experimentId !== undefined
  )
    return record;
  return {
    ...record,
    properties: { ...record.properties, experimentId: scope.experimentId },
  };
}

function openLog(scope: Invocation, path: string): void {
  const absolute = resolve(scope.workspace, path);
  mkdirSync(dirname(absolute), { recursive: true });
  scope.file = { path, descriptor: openSync(absolute, 'a', 0o600) };
}

function openDefaultLog(scope: Invocation, experimentId?: string): void {
  try {
    if (
      experimentId !== undefined ||
      statSync(join(scope.workspace, '.rsi'), {
        throwIfNoEntry: false,
      })?.isDirectory()
    )
      openLog(scope, `.rsi/logs/${experimentId ?? 'cli'}.log`);
  } catch (error) {
    cliLogger.warn('Could not open workspace log: {summary}', {
      error,
      summary: singleLine(formatLogError(error)),
    });
  }
}

function writeFileLog(scope: Invocation, record: LogRecord): void {
  const file = scope.file;
  if (!file) return;
  if (scope.command === 'run') {
    const unique = deduplicateError(
      record,
      scope.fileErrors,
      scope.callParents,
    );
    if (!unique) return;
    record = unique;
  }
  try {
    writeSync(file.descriptor, formatLogLine(withExperiment(record, scope)));
    file.hasRecords = true;
  } catch (error) {
    scope.file = undefined;
    closeSync(file.descriptor);
    cliLogger.warn('Could not write to {path}: {summary}', {
      path: file.path,
      error,
      summary: singleLine(formatLogError(error)),
    });
  }
}

function flushPending(scope: Invocation): void {
  const pending = scope.pending;
  scope.pending = undefined;
  openDefaultLog(scope, scope.experimentId);
  for (const record of pending ?? []) writeFileLog(scope, record);
}

function isManagerLog(record: LogRecord): boolean {
  return record.category.join('.') === 'arsi.runtime.manager';
}

function showCargoRunRecord(
  scope: Invocation,
  record: LogRecord,
  show: (record: LogRecord, mode: TerminalMode) => void,
): void {
  const { callId, parentCallId, label, stage, applicationAction, durationMs } =
    record.properties;
  if (
    stage === 'Completed' &&
    (applicationAction === 'acquire' || applicationAction === 'release') &&
    typeof durationMs === 'number' &&
    durationMs < 500
  )
    return;

  if (
    stage === 'Reused' &&
    typeof callId === 'string' &&
    typeof label === 'string'
  ) {
    scope.calls.set(callId, { label: singleLine(label), reused: true });
    scope.announcedParents.add(callId);
    scope.visibleParents = [callId];
    show(record, 'cargo');
    return;
  }

  // Plugin progress refers to its owning call, while lifecycle records refer to its parent.
  const owner = parentCallId ?? callId;
  const parents = callBranch(
    scope.calls,
    typeof owner === 'string' ? owner : undefined,
  );
  const canAnnounce =
    !scope.quiet &&
    (record.properties.terminalOnly === true ||
      accepts(
        'info',
        terminalThreshold(scope, ['arsi', 'runtime', 'manager']),
      ));
  let onSameBranch = true;
  if (canAnnounce) {
    for (const [depth, parent] of parents.entries()) {
      onSameBranch &&= scope.visibleParents[depth] === parent.id;
      if (onSameBranch) continue;
      const first = !scope.announcedParents.has(parent.id);
      show(
        {
          ...record,
          rawMessage: parent.label,
          message: [parent.label],
          properties: {
            stage: parent.reused ? 'Reused' : 'Running',
            cargoDepth: depth,
            cargoHeaderOnly:
              !parent.reused && (!first || !scope.tasks.has(parent.id)),
          },
        },
        'cargo',
      );
      scope.announcedParents.add(parent.id);
    }
  }
  scope.visibleParents = canAnnounce ? parents.map(({ id }) => id) : [];
  if (parents.length)
    record = {
      ...record,
      properties: {
        ...record.properties,
        ...(canAnnounce
          ? { cargoDepth: parents.length }
          : { cargoBreadcrumb: parents.map(({ label }) => label).join(' → ') }),
      },
    };
  show(record, 'cargo');
}

function isAncestor(
  ancestorId: string,
  callId: string,
  callParents: ReadonlyMap<string, string>,
): boolean {
  const visited = new Set<string>();
  let current: string | undefined = callId;
  while (current && !visited.has(current)) {
    if (current === ancestorId) return true;
    visited.add(current);
    current = callParents.get(current);
  }
  return false;
}

function deduplicateError(
  record: LogRecord,
  seen: Map<unknown, Set<string | undefined>>,
  callParents: ReadonlyMap<string, string>,
  plain = false,
): LogRecord | undefined {
  const { error, cliDiagnostic, diagnosticPrefix } = record.properties;
  if (!('error' in record.properties) || diagnosticPrefix) return record;
  const id = record.properties.callId;
  const callId = typeof id === 'string' ? id : undefined;
  const previous = seen.get(error);
  const duplicate =
    previous &&
    (cliDiagnostic ||
      (callId
        ? [...previous].some(
            (origin) =>
              origin !== undefined &&
              (isAncestor(origin, callId, callParents) ||
                isAncestor(callId, origin, callParents)),
          )
        : error instanceof Error && previous.has(undefined)));
  if (!duplicate) {
    if (previous) previous.add(callId);
    else seen.set(error, new Set([callId]));
    return record;
  }
  if (cliDiagnostic || plain) return undefined;
  const { error: _error, ...properties } = record.properties;
  return { ...record, properties };
}

export function configureCliLogging(
  interactive: boolean,
  write = (text: string): void => {
    process.stderr.write(text);
  },
): CliLogging {
  let terminalSink:
    | ((record: LogRecord, mode: TerminalMode) => void)
    | undefined;
  let taskSink: ((task?: RunningTask) => void) | undefined;
  const show = (record: LogRecord, mode: TerminalMode): void => {
    if (terminalSink) terminalSink(record, mode);
    else writeTerminal(record, mode, write);
  };
  configureSync({
    contextLocalStorage: new AsyncLocalStorage(),
    sinks: {
      file(record) {
        const scope = invocation.getStore();
        if (
          !scope ||
          scope.closed ||
          record.properties.terminalOnly === true ||
          record.properties.progressOnly === true
        )
          return;
        const { callId, parentCallId } = record.properties;
        if (typeof callId === 'string' && typeof parentCallId === 'string')
          scope.callParents.set(callId, parentCallId);
        const id = record.properties.experimentId;
        if (
          scope.command === 'run' &&
          !scope.experimentId &&
          typeof id === 'string' &&
          isManagerLog(record)
        ) {
          scope.experimentId = validatedId(id);
          if (scope.experimentId && scope.pending) flushPending(scope);
        }
        if (
          !accepts(
            record.level,
            moduleLevel(record.category, scope.levels) ??
              scope.levels.level ??
              'debug',
          )
        )
          return;
        if (scope.pending) scope.pending.push(record);
        else writeFileLog(scope, record);
      },
      terminal(record) {
        const scope = invocation.getStore();
        if (scope?.closed) return;
        const mode = scope?.mode ?? (interactive ? 'cargo' : 'plain');
        const {
          activeTask,
          cliDiagnostic,
          inResult,
          stage,
          terminalOnly,
          progressOnly,
        } = record.properties;
        if (scope && stage === 'Preparing' && isManagerLog(record)) {
          const id = record.properties.experimentId;
          if (typeof id === 'string') scope.preparedId = validatedId(id);
        }
        if (
          scope &&
          stage === 'Finished' &&
          record.category.join('.') === 'arsi.cli'
        )
          scope.failed = record.properties.status === 'failed';
        const settings = scope?.levels ?? {};
        const threshold =
          moduleLevel(record.category, settings) ??
          settings.level ??
          (interactive || scope?.command === 'dashboard' ? 'info' : 'warning');
        if (
          scope &&
          mode === 'cargo' &&
          updateTasks(
            scope,
            activeTask,
            record.timestamp,
            !scope.quiet && threshold !== 'off',
          )
        )
          taskSink?.(Array.from(scope.tasks.values()).at(-1));
        if (progressOnly === true) return;
        const quietFailureLog =
          scope?.quiet &&
          scope.failed &&
          scope.file?.hasRecords &&
          stage === 'Log' &&
          terminalOnly === true;
        if (
          !quietFailureLog &&
          ((!cliDiagnostic && !accepts(record.level, threshold)) ||
            (scope?.quiet && !accepts(record.level, 'error')))
        )
          return;
        if (
          inResult === true &&
          (mode === 'plain' || scope?.command === 'doctor')
        )
          return;
        if (scope) {
          record = withExperiment(record, scope);
          // The CLI reports the final status after releasing the Runtime.
          if (scope.command === 'run' && isManagerLog(record)) {
            if (stage === 'Finished') return;
            if (stage === 'Usage' && mode === 'cargo') {
              scope.usage = record;
              return;
            }
          }
          if (scope.command === 'run') {
            const unique = deduplicateError(
              record,
              scope.terminalErrors,
              scope.callParents,
              mode === 'plain',
            );
            if (!unique) return;
            record = unique;
          }
        }
        if (scope?.command === 'run' && mode === 'cargo')
          showCargoRunRecord(scope, record, show);
        else show(record, mode);
      },
    },
    loggers: [
      { category: ['arsi'], lowestLevel: 'trace', sinks: ['file', 'terminal'] },
      { category: ['logtape', 'meta'], lowestLevel: null },
    ],
  });
  return {
    async run<T>(
      options: LogOptions,
      execute: () => Promise<T>,
      { command, experimentId, workspace = process.cwd() }: LogContext = {},
    ): Promise<T> {
      const settings = configuredLevels(options);
      const scope: Invocation = {
        command,
        workspace,
        experimentId: validatedId(experimentId),
        levels: settings,
        quiet: options.quiet,
        mode: terminalMode(
          command,
          settings,
          interactive,
          options.logLevel !== undefined,
        ),
        tasks: new Map(),
        calls: new Map(),
        announcedParents: new Set(),
        visibleParents: [],
        callParents: new Map(),
        fileErrors: new Map(),
        terminalErrors: new Map(),
      };
      return invocation.run(scope, () =>
        withContext({ command, experimentId: scope.experimentId }, async () => {
          try {
            if (!options.noLogFile) {
              if (options.logFile !== undefined)
                openLog(scope, options.logFile);
              else if (command === 'run' && scope.experimentId === undefined)
                scope.pending = [];
              else
                openDefaultLog(
                  scope,
                  command === 'run' ? scope.experimentId : undefined,
                );
            }
            return await execute();
          } finally {
            try {
              if (scope.pending) flushPending(scope);
              if (scope.usage) show(scope.usage, scope.mode);
              if (scope.file && command !== undefined)
                cliLogger.info('{path}', {
                  stage: 'Log',
                  path: scope.file.path,
                  terminalOnly: true,
                });
            } finally {
              scope.closed = true;
              if (scope.tasks.size) taskSink?.();
              if (scope.file) closeSync(scope.file.descriptor);
            }
          }
        }),
      );
    },
    takeTerminal(sink, onTask) {
      const previousSink = terminalSink;
      const previousTaskSink = taskSink;
      terminalSink = sink;
      taskSink = onTask;
      return () => {
        if (terminalSink === sink) {
          terminalSink = previousSink;
          taskSink = previousTaskSink;
        }
      };
    },
    dispose: resetSync,
  };
}
