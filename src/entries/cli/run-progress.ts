import type {
  ReusedCallSummary,
  RunFinishedProgress,
  RunProgressReporter,
} from '../../runtime/services/run-progress.js';
import {
  createTerminalRenderer,
  resolveProgressMode,
  sanitizeText,
  type ProgressMode,
  type ProgressStream,
  type ResolvedProgressMode,
  type StylePalette,
} from './terminal-renderer.js';

const defaultTickMs = 125;
const defaultPlainHeartbeatMs = 60_000;
const maxVisibleActive = 4;
const maxListedReused = 5;
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const internalCallPathPattern = /^call-[a-f0-9]{16,}$/i;

export interface RunProgressOptions {
  stream: ProgressStream;
  recipe: string;
  id?: string;
  resume: boolean;
  mode?: ProgressMode;
  verbose?: boolean;
  tickMs?: number;
  plainHeartbeatMs?: number;
  now?: () => number;
  onErrorReported?: (normalizedError: string) => void;
}

export interface RunProgressOutput {
  readonly mode: ResolvedProgressMode;
  observe: RunProgressReporter;
  finish(status: RunFinishedProgress['status']): void;
}

interface ActiveCall {
  readonly callId: string;
  readonly label: string;
  readonly fullLabel: string;
  readonly contractId: string;
  readonly started: number;
  readonly topLevel: boolean;
  detail: string;
  lines: string[];
  lastNotice: string;
  lastPlainDetail: string;
  lastChildError?: string;
}

export function formatDuration(ms: number): string {
  const safeMs = Math.max(0, ms);
  if (safeMs < 60_000) return `${(safeMs / 1000).toFixed(1)}s`;
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function padTag(label: string): string {
  return label.padStart(10);
}

function statusStyle(
  status: string,
  style: StylePalette,
): (text: string) => string {
  if (status === 'succeeded') return style.green;
  if (status === 'failed') return style.red;
  if (status === 'cancelled' || status === 'unknown') return style.yellow;
  return style.cyan;
}

function statusTitle(status: string): string {
  if (status === 'succeeded') return 'Completed';
  if (status === 'failed') return 'Failed';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'unknown') return 'Unknown';
  return 'Status';
}

function formatCallLabel(
  bindingId: string,
  path: string,
  compact: boolean,
): string {
  const cleanBinding = sanitizeText(bindingId);
  const cleanPath = sanitizeText(path);
  if (!compact) return `${cleanBinding} (${cleanPath})`;
  if (cleanBinding === '_application') {
    return cleanPath === 'initialize'
      ? 'initialize'
      : `application (${cleanPath})`;
  }
  if (!cleanPath || internalCallPathPattern.test(cleanPath)) {
    return cleanBinding;
  }
  const displayPath = cleanPath.startsWith('steps/')
    ? cleanPath.slice('steps/'.length)
    : cleanPath;
  return `${cleanBinding} (${displayPath})`;
}

function formatReusedList(
  calls: readonly ReusedCallSummary[],
  compact: boolean,
): string {
  const labels = calls.map((item) =>
    formatCallLabel(item.bindingId, item.path, compact),
  );
  if (labels.length <= maxListedReused) return labels.join(', ');
  return [
    labels[0],
    labels[1],
    '…',
    labels[labels.length - 2],
    labels[labels.length - 1],
  ].join(', ');
}

function formatUsageMap(usage: Readonly<Record<string, number>>): string {
  return Object.entries(usage)
    .map(([metric, count]) => `${sanitizeText(metric)}=${count}`)
    .join(' ');
}

export function startRunProgress(
  options: RunProgressOptions,
): RunProgressOutput {
  const now = options.now ?? (() => performance.now());
  const resolvedMode = resolveProgressMode(
    options.mode ?? 'auto',
    options.stream,
  );
  const verbose = options.verbose === true;
  const compactLabels = resolvedMode === 'tty' && !verbose;
  const renderer = createTerminalRenderer(options.stream, resolvedMode);
  const { style } = renderer;

  const started = now();
  const recipeLabel = sanitizeText(options.recipe);
  const active = new Map<string, ActiveCall>();
  const callParents = new Map<string, string>();
  const reportedErrors = new Set<string>();
  let experimentId = options.id ? sanitizeText(options.id) : undefined;
  let phase: 'loading' | 'running' | 'cleaning' = 'loading';
  let completedSteps = 0;
  let completedRounds = 0;
  let finished: RunFinishedProgress | undefined;
  let frame = 0;
  let closed = false;

  function elapsedText(): string {
    return formatDuration(now() - started);
  }

  function plainLine(message: string): string {
    return `[arsi +${elapsedText()}] ${sanitizeText(message)}`;
  }

  function ttyTag(label: string, color?: (text: string) => string): string {
    const padded = padTag(label);
    return color ? style.bold(color(padded)) : style.dim(padded);
  }

  function resolveOwnerCallId(callId: string, parentCallId: string): string {
    let current = callId;
    let parent: string | undefined = parentCallId;
    const seen = new Set<string>();
    while (parent && parent !== 'root' && !seen.has(current)) {
      seen.add(current);
      current = parent;
      parent = callParents.get(current);
    }
    return current;
  }

  function noteReportedError(message: string): void {
    if (!message) return;
    reportedErrors.add(message);
    options.onErrorReported?.(message);
  }

  function visibleActiveCalls(): ActiveCall[] {
    const all = [...active.values()];
    if (verbose) return all;
    const topLevel = all.filter((entry) => entry.topLevel);
    return topLevel.length > 0 ? topLevel : all;
  }

  function buildStickyLines(): string[] {
    const spinner = style.cyan(spinnerFrames[frame % spinnerFrames.length]!);
    if (phase === 'loading') {
      return [
        `${spinner} Loading Runtime and Recipe ${recipeLabel} ${style.dim(`· ${elapsedText()}`)}`,
      ];
    }
    if (phase === 'cleaning') {
      return [
        `${spinner} ${style.bold('Cleaning up')} ${style.dim(`· ${elapsedText()}`)}`,
      ];
    }
    const calls = visibleActiveCalls();
    const chips = [elapsedText()];
    if (completedRounds > 0) chips.push(`round ${completedRounds}`);
    if (completedSteps > 0)
      chips.push(
        `${completedSteps} ${completedSteps === 1 ? 'step' : 'steps'}`,
      );
    if (calls.length > 0) chips.push(`${calls.length} active`);

    const lines = [
      `${spinner} ${style.bold('Running')} ${style.dim(`· ${chips.join(' · ')}`)}`,
    ];
    const shown = calls.slice(0, maxVisibleActive);
    const overflow = calls.length - shown.length;
    const maxSubLines = shown.length <= 1 ? 6 : shown.length === 2 ? 3 : 2;
    for (let i = 0; i < shown.length; i++) {
      const call = shown[i]!;
      const isLast = i === shown.length - 1 && overflow === 0;
      const connector = isLast ? '└─' : '├─';
      const callElapsed = formatDuration(now() - call.started);
      const detail = call.detail ? ` ${style.dim(`· ${call.detail}`)}` : '';
      lines.push(
        `  ${style.dim(connector)} ${call.label} ${style.dim(callElapsed)}${detail}`,
      );
      if (call.lines.length > 0) {
        const branchGutter = isLast ? '  ' : `${style.dim('│')} `;
        const subLines = call.lines.slice(0, maxSubLines);
        for (const sub of subLines) {
          lines.push(`  ${branchGutter}  ${style.dim(`│ ${sub}`)}`);
        }
      }
    }
    if (overflow > 0) {
      lines.push(`  ${style.dim(`└─ +${overflow} more active`)}`);
    }
    return lines;
  }

  function refreshSticky(): void {
    if (closed || resolvedMode !== 'tty') return;
    renderer.setStatus(buildStickyLines());
  }

  const action = options.resume ? 'resume' : 'run';
  if (resolvedMode === 'tty') {
    const target = experimentId ? ` ${style.dim(`(${experimentId})`)}` : '';
    renderer.printMilestone([
      `${ttyTag(options.resume ? 'Resuming' : 'Starting', style.cyan)}  ${recipeLabel}${target}`,
    ]);
    refreshSticky();
  } else {
    renderer.printMilestone([
      plainLine(
        `Loading Runtime and Recipe ${recipeLabel} (${experimentId ? `${action} ${experimentId}` : action})`,
      ),
    ]);
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  if (resolvedMode === 'tty') {
    const tickMs = options.tickMs ?? defaultTickMs;
    if (tickMs > 0) {
      timer = setInterval(() => {
        frame = (frame + 1) % spinnerFrames.length;
        refreshSticky();
      }, tickMs);
      timer.unref();
    }
  } else {
    const heartbeatMs = options.plainHeartbeatMs ?? defaultPlainHeartbeatMs;
    if (heartbeatMs > 0) {
      timer = setInterval(() => {
        const calls = visibleActiveCalls();
        const call = calls[0];
        if (!call) return;
        const elapsed = formatDuration(now() - call.started);
        const detailParts = [call.detail, call.lines[0]].filter(Boolean);
        const detail =
          detailParts.length > 0 ? ` · ${detailParts.join(' · ')}` : '';
        const count = calls.length > 1 ? `, ${calls.length} calls active` : '';
        renderer.printMilestone([
          plainLine(
            `Still running ${call.fullLabel} (${elapsed} elapsed${detail}${count})`,
          ),
        ]);
      }, heartbeatMs);
      timer.unref();
    }
  }

  return {
    mode: resolvedMode,
    observe(event) {
      if (closed) return;
      switch (event.kind) {
        case 'experiment-preparing': {
          phase = 'running';
          experimentId = sanitizeText(event.experimentId);
          const policyId = sanitizeText(event.policyId);
          if (resolvedMode === 'tty') {
            renderer.printMilestone([
              `${ttyTag('Preparing', style.cyan)}  ${experimentId} ${style.dim(`(policy ${policyId})`)}`,
            ]);
            refreshSticky();
          } else {
            renderer.printMilestone([
              plainLine(`Experiment ${experimentId} using Policy ${policyId}`),
            ]);
          }
          break;
        }
        case 'experiment-resumed': {
          const lines: string[] = [];
          const count = event.reusedCalls.length;
          const usageText = formatUsageMap(event.priorUsage);
          if (resolvedMode === 'tty') {
            if (count > 0) {
              const unit = count === 1 ? 'call' : 'calls';
              const list = formatReusedList(event.reusedCalls, compactLabels);
              lines.push(
                `${ttyTag('Reused', style.cyan)}  ${count} completed ${unit} ${style.dim(`(${list})`)}`,
              );
            }
            if (usageText) {
              lines.push(`${ttyTag('Prior')}  ${style.dim(usageText)}`);
            }
            if (lines.length > 0) {
              renderer.printMilestone(lines);
              refreshSticky();
            }
          } else {
            if (count > 0) {
              const unit = count === 1 ? 'call' : 'calls';
              const list = formatReusedList(event.reusedCalls, false);
              lines.push(
                plainLine(`Reused ${count} completed ${unit} (${list})`),
              );
            }
            if (usageText) {
              lines.push(plainLine(`Prior usage ${usageText}`));
            }
            if (lines.length > 0) renderer.printMilestone(lines);
          }
          break;
        }
        case 'call': {
          const topLevel = event.parentCallId === 'root';
          const label = formatCallLabel(
            event.bindingId,
            event.path,
            compactLabels,
          );
          const fullLabel = formatCallLabel(event.bindingId, event.path, false);
          if (event.status === 'running') {
            callParents.set(event.callId, event.parentCallId);
            active.set(event.callId, {
              callId: event.callId,
              label,
              fullLabel,
              contractId: event.contractId,
              started: now(),
              topLevel,
              detail: '',
              lines: [],
              lastNotice: '',
              lastPlainDetail: '',
            });
            if (resolvedMode === 'tty') {
              refreshSticky();
            } else if (topLevel || verbose) {
              renderer.printMilestone([plainLine(`Running ${fullLabel}`)]);
            }
            break;
          }

          const entry = active.get(event.callId);
          active.delete(event.callId);
          const ownerId = resolveOwnerCallId(event.callId, event.parentCallId);
          const owner =
            ownerId !== event.callId ? active.get(ownerId) : undefined;
          callParents.delete(event.callId);

          const duration = entry ? formatDuration(now() - entry.started) : '';
          const rawSummary =
            (verbose && event.verboseSummary) || event.summary || '';
          const summary = rawSummary ? sanitizeText(rawSummary) : '';
          const errorDetail = event.error ? sanitizeText(event.error) : '';
          const isFailure = event.status !== 'succeeded';

          // Roll nested agent failures into the owning business call so the
          // same error is not printed twice with an internal call UUID.
          if (
            isFailure &&
            !topLevel &&
            !verbose &&
            owner &&
            event.contractId === 'contract.agent'
          ) {
            if (errorDetail) owner.lastChildError = errorDetail;
            refreshSticky();
            break;
          }

          const effectiveError = errorDetail || entry?.lastChildError || '';
          const alreadyPrintedError =
            effectiveError !== '' && reportedErrors.has(effectiveError);

          if (isFailure || topLevel || verbose) {
            if (resolvedMode === 'tty') {
              const color = statusStyle(event.status, style);
              const metaParts = [duration, summary].filter(Boolean);
              const meta =
                metaParts.length > 0
                  ? ` ${style.dim(metaParts.join(' · '))}`
                  : '';
              const lines = [
                `${ttyTag(statusTitle(event.status), color)}  ${label}${meta}`,
              ];
              if (isFailure && effectiveError && !alreadyPrintedError) {
                lines.push(
                  `            ${style.red('error:')} ${effectiveError}`,
                );
                noteReportedError(effectiveError);
              }
              renderer.printMilestone(lines);
            } else {
              const suffix = duration ? ` in ${duration}` : '';
              const summarySuffix = summary ? ` (${summary})` : '';
              const lines = [
                plainLine(
                  `Call ${fullLabel} ${event.status}${suffix}${summarySuffix}`,
                ),
              ];
              if (isFailure && effectiveError && !alreadyPrintedError) {
                lines.push(plainLine(`error: ${effectiveError}`));
                noteReportedError(effectiveError);
              }
              renderer.printMilestone(lines);
            }
          }
          refreshSticky();
          break;
        }
        case 'call-progress': {
          const ownerId = resolveOwnerCallId(event.callId, event.parentCallId);
          const target =
            active.get(verbose ? event.callId : ownerId) ??
            active.get(event.callId) ??
            active.get(ownerId);
          const detail = event.detail ? sanitizeText(event.detail) : '';
          const subLines = event.lines
            ? event.lines.map(sanitizeText).filter(Boolean)
            : undefined;
          const notice = event.notice ? sanitizeText(event.notice) : '';
          const verboseNotice =
            verbose && event.verboseNotice
              ? sanitizeText(event.verboseNotice)
              : '';
          if (target) {
            if (detail) target.detail = detail;
            if (subLines !== undefined) target.lines = subLines;
          }
          const plainSnapshot = [detail, ...(subLines ?? [])]
            .filter(Boolean)
            .join(' · ');
          const detailChanged =
            plainSnapshot !== '' &&
            (!target || plainSnapshot !== target.lastPlainDetail);
          if (target && detailChanged) target.lastPlainDetail = plainSnapshot;

          const noticeKey = verboseNotice
            ? `${notice}\n${verboseNotice}`
            : notice;
          if (notice && (!target || noticeKey !== target.lastNotice)) {
            if (target) target.lastNotice = noticeKey;
            const level = event.level ?? 'info';
            const displayLabel =
              target?.label ??
              formatCallLabel(event.bindingId, event.path, compactLabels);
            if (resolvedMode === 'tty') {
              const tag =
                level === 'error'
                  ? ttyTag('Error', style.red)
                  : level === 'warning'
                    ? ttyTag('Warning', style.yellow)
                    : ttyTag('Progress', style.dim);
              renderer.printMilestone([
                `${tag}  ${style.dim(displayLabel)} ${notice}`,
                ...(verboseNotice
                  ? [`            ${style.dim(verboseNotice)}`]
                  : []),
              ]);
            } else {
              const prefix =
                level === 'error'
                  ? 'Error'
                  : level === 'warning'
                    ? 'Warning'
                    : 'Progress';
              renderer.printMilestone([
                plainLine(
                  `${prefix} (${target?.fullLabel ?? displayLabel}): ${notice}`,
                ),
                ...(verboseNotice
                  ? [plainLine(`Diagnostic ${verboseNotice}`)]
                  : []),
              ]);
            }
          } else if (resolvedMode === 'plain' && verbose && detailChanged) {
            const label =
              target?.fullLabel ??
              formatCallLabel(event.bindingId, event.path, false);
            renderer.printMilestone([plainLine(`${label}: ${plainSnapshot}`)]);
          }
          refreshSticky();
          break;
        }
        case 'revision-activated': {
          const targets = event.bindingIds.map(sanitizeText).join(', ');
          if (!targets) break;
          if (resolvedMode === 'tty') {
            renderer.printMilestone([
              `${ttyTag('Revised', style.cyan)}  activated revision for ${targets}`,
            ]);
            refreshSticky();
          } else {
            renderer.printMilestone([
              plainLine(`Activated revision for ${targets}`),
            ]);
          }
          break;
        }
        case 'step-completed': {
          completedSteps += 1;
          const stepPath = sanitizeText(event.stepPath);
          if (verbose) {
            if (resolvedMode === 'tty') {
              renderer.printMilestone([`${ttyTag('Step')}  ${stepPath}`]);
            } else {
              renderer.printMilestone([
                plainLine(`Completed step ${stepPath}`),
              ]);
            }
          }
          refreshSticky();
          break;
        }
        case 'iteration-completed': {
          const round = event.iteration + 1;
          completedRounds = Math.max(completedRounds, round);
          const stepPath = sanitizeText(event.stepPath);
          if (resolvedMode === 'tty') {
            const displayPath =
              compactLabels && stepPath.startsWith('steps/')
                ? stepPath.slice('steps/'.length)
                : stepPath;
            renderer.printMilestone([
              `${ttyTag('Round', style.cyan)}  ${round} completed ${style.dim(`(${displayPath})`)}`,
            ]);
            refreshSticky();
          } else {
            renderer.printMilestone([
              plainLine(`Completed round ${round} (${stepPath})`),
            ]);
          }
          break;
        }
        case 'experiment-cleaning': {
          phase = 'cleaning';
          refreshSticky();
          break;
        }
        case 'experiment-finished':
          finished = event;
          break;
      }
    },
    finish(status) {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      active.clear();
      callParents.clear();
      const total = elapsedText();
      if (!finished) {
        if (resolvedMode === 'tty') {
          const color = statusStyle(status, style);
          const target = experimentId ? ` ${experimentId}` : '';
          renderer.finish([
            `${ttyTag('Finished', color)}  Run${target} ${status} ${style.dim(`in ${total}`)}`,
          ]);
        } else {
          const target = experimentId ? ` (${experimentId})` : '';
          renderer.finish([plainLine(`Run ${status}${target}`)]);
        }
        return;
      }

      const expId = sanitizeText(finished.experimentId);
      const reused = finished.reused ? ' (saved result)' : '';
      const stopReason = finished.stopReason
        ? `${sanitizeText(finished.stopReason)}${finished.budgetMetric ? ` (${sanitizeText(finished.budgetMetric)})` : ''}`
        : '';
      const usageText = formatUsageMap(finished.usage);
      const refs = [
        finished.candidateRef
          ? `candidate=${sanitizeText(finished.candidateRef)}`
          : '',
        finished.measurementRef
          ? `measurement=${sanitizeText(finished.measurementRef)}`
          : '',
      ].filter(Boolean);

      if (resolvedMode === 'tty') {
        const color = statusStyle(finished.status, style);
        const lines = [
          `${ttyTag('Finished', color)}  ${expId} ${finished.status}${reused} ${style.dim(`in ${total}`)}`,
        ];
        if (stopReason) lines.push(`${ttyTag('Stopped')}  ${stopReason}`);
        if (usageText) lines.push(`${ttyTag('Usage')}  ${usageText}`);
        if (refs.length > 0) {
          lines.push(
            `${ttyTag(finished.partial ? 'Partial' : 'Result')}  ${refs.join(' ')}`,
          );
        }
        renderer.finish(lines);
        return;
      }

      const lines = [
        plainLine(`Experiment ${expId} ${finished.status}${reused}`),
      ];
      if (stopReason) lines.push(plainLine(`Stop reason ${stopReason}`));
      if (usageText) lines.push(plainLine(`Usage ${usageText}`));
      if (refs.length > 0) {
        lines.push(
          plainLine(
            `${finished.partial ? 'Partial result' : 'Result'} ${refs.join(' ')}`,
          ),
        );
      }
      renderer.finish(lines);
    },
  };
}
