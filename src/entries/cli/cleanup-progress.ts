import type {
  BindingCleanupResult,
  ExperimentCleanupReport,
} from '../../runtime/manager/cleanup.js';
import type {
  CleanupProgress,
  WorkspaceCleanupEntry,
  WorkspaceCleanupReport,
} from './cleanup.js';
import { formatDuration } from './run-progress.js';
import {
  createTerminalRenderer,
  resolveProgressMode,
  sanitizeText,
  type ProgressMode,
  type ProgressStream,
  type ResolvedProgressMode,
} from './terminal-renderer.js';

const defaultTickMs = 125;
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface CleanupProgressOptions {
  stream: ProgressStream;
  scope: 'experiment' | 'workspace';
  experimentId?: string;
  dryRun: boolean;
  mode?: ProgressMode;
  verbose?: boolean;
  tickMs?: number;
  now?: () => number;
  onErrorReported?: (normalizedError: string) => void;
}

export interface CleanupProgressOutput {
  readonly mode: ResolvedProgressMode;
  observe(event: CleanupProgress): void;
  finish(status: 'completed' | 'cancelled' | 'failed', error?: string): void;
}

interface ImageCounts {
  deleted: number;
  candidate: number;
  retained: number;
  skipped: number;
  failed: number;
}

interface ResultSummary {
  total: number;
  complete: number;
  preview: number;
  pending: number;
  images: ImageCounts;
  errors: Array<{ bindingId: string; key: string; message: string }>;
}

function padTag(label: string): string {
  return label.padStart(10);
}

function emptyImages(): ImageCounts {
  return { deleted: 0, candidate: 0, retained: 0, skipped: 0, failed: 0 };
}

function collectReportStats(
  result: BindingCleanupResult,
  images: ImageCounts,
  errors: ResultSummary['errors'],
): void {
  let reportedError = false;
  if (result.error) {
    errors.push({
      bindingId: result.bindingId,
      key: result.key,
      message: result.error,
    });
    reportedError = true;
  }
  const report = result.report;
  if (!report || !Array.isArray(report.nodes)) return;
  for (const rawNode of report.nodes) {
    if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode))
      continue;
    const node = rawNode as Record<string, unknown>;
    if (typeof node.error === 'string' && node.error && !reportedError) {
      errors.push({
        bindingId: result.bindingId,
        key: result.key,
        message: node.error,
      });
      reportedError = true;
    }
    if (!Array.isArray(node.items)) continue;
    for (const rawItem of node.items) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem))
        continue;
      const status = (rawItem as Record<string, unknown>).status;
      if (status === 'deleted') images.deleted += 1;
      else if (status === 'candidate') images.candidate += 1;
      else if (status === 'retained') images.retained += 1;
      else if (status === 'skipped') images.skipped += 1;
      else if (status === 'failed') images.failed += 1;
    }
  }
}

function summarizeResults(
  results: readonly BindingCleanupResult[],
): ResultSummary {
  const images = emptyImages();
  const errors: ResultSummary['errors'] = [];
  let complete = 0;
  let preview = 0;
  let pending = 0;
  for (const result of results) {
    if (result.status === 'complete') complete += 1;
    else if (result.status === 'preview') preview += 1;
    else pending += 1;
    collectReportStats(result, images, errors);
  }
  return {
    total: results.length,
    complete,
    preview,
    pending,
    images,
    errors,
  };
}

function formatImageParts(images: ImageCounts): string[] {
  const parts: string[] = [];
  if (images.deleted > 0) parts.push(`${images.deleted} deleted`);
  if (images.candidate > 0) parts.push(`${images.candidate} candidate`);
  if (images.retained > 0) parts.push(`${images.retained} retained`);
  if (images.skipped > 0) parts.push(`${images.skipped} skipped`);
  if (images.failed > 0) parts.push(`${images.failed} failed`);
  return parts;
}

function formatResultDetails(summary: ResultSummary): string {
  if (summary.total === 0) return 'nothing to clean';
  const parts: string[] = [];
  if (summary.pending > 0) {
    parts.push(`${summary.pending}/${summary.total} pending`);
  } else {
    parts.push(
      `${summary.total} ${summary.total === 1 ? 'receipt' : 'receipts'}`,
    );
  }
  parts.push(...formatImageParts(summary.images));
  return parts.join(' · ');
}

function formatReceiptDetail(result: BindingCleanupResult): string {
  const summary = summarizeResults([result]);
  const imageParts = formatImageParts(summary.images);
  const meta = [result.status, ...imageParts].join(' · ');
  const error = result.error ? `: ${sanitizeText(result.error)}` : '';
  return `${sanitizeText(result.key)} (${meta})${error}`;
}

export function startCleanupProgress(
  options: CleanupProgressOptions,
): CleanupProgressOutput {
  const now = options.now ?? (() => performance.now());
  const resolvedMode = resolveProgressMode(
    options.mode ?? 'auto',
    options.stream,
  );
  const verbose = options.verbose === true;
  const renderer = createTerminalRenderer(options.stream, resolvedMode);
  const { style } = renderer;

  const started = now();
  const verb = options.dryRun ? 'Previewing' : 'Cleaning';
  const targetLabel =
    options.scope === 'workspace'
      ? 'workspace'
      : sanitizeText(options.experimentId ?? '');
  const modeSuffix = options.dryRun
    ? ' (dry-run)'
    : options.scope === 'workspace'
      ? ' (all experiments)'
      : '';

  let phase: 'loading' | 'running' = 'loading';
  let totalExperiments = options.scope === 'experiment' ? 1 : 0;
  let completedExperiments = 0;
  let activeExperiment:
    | {
        experimentId: string;
        started: number;
        totalBindings: number;
        completedBindings: number;
      }
    | undefined;
  let activeBinding:
    | {
        experimentId: string;
        bindingId: string;
        pluginId: string;
        started: number;
        detail: string;
      }
    | undefined;
  let finalExperimentReport: ExperimentCleanupReport | undefined;
  let finalWorkspaceReport: WorkspaceCleanupReport | undefined;
  let frame = 0;
  let closed = false;

  function elapsedText(): string {
    return formatDuration(now() - started);
  }

  function plainLine(message: string): string {
    return `[arsi cleanup +${elapsedText()}] ${sanitizeText(message)}`;
  }

  function ttyTag(label: string, color?: (text: string) => string): string {
    const padded = padTag(label);
    return color ? style.bold(color(padded)) : style.dim(padded);
  }

  function buildStickyLines(): string[] {
    const spinner = style.cyan(spinnerFrames[frame % spinnerFrames.length]!);
    if (phase === 'loading') {
      return [`${spinner} Loading Runtime ${style.dim(`· ${elapsedText()}`)}`];
    }

    if (options.scope === 'workspace') {
      const chips = [elapsedText()];
      if (totalExperiments > 0) {
        chips.push(
          `${completedExperiments}/${totalExperiments} ${totalExperiments === 1 ? 'experiment' : 'experiments'}`,
        );
      }
      const lines = [
        `${spinner} ${style.bold(`${verb} workspace`)} ${style.dim(`· ${chips.join(' · ')}`)}`,
      ];
      if (activeExperiment) {
        const expElapsed = formatDuration(now() - activeExperiment.started);
        const expChips = [expElapsed];
        if (activeExperiment.totalBindings > 0) {
          expChips.push(
            `${activeExperiment.completedBindings}/${activeExperiment.totalBindings} bindings`,
          );
        }
        const branch = activeBinding ? '├─' : '└─';
        lines.push(
          `  ${style.dim(branch)} ${activeExperiment.experimentId} ${style.dim(`· ${expChips.join(' · ')}`)}`,
        );
      }
      if (activeBinding) {
        const bindingElapsed = formatDuration(now() - activeBinding.started);
        const detail = activeBinding.detail
          ? ` ${style.dim(`· ${activeBinding.detail}`)}`
          : '';
        lines.push(
          `  ${style.dim('└─')} ${activeBinding.bindingId} ${style.dim(`(${activeBinding.pluginId}) ${bindingElapsed}`)}${detail}`,
        );
      }
      return lines;
    }

    const chips = [elapsedText()];
    if (activeExperiment && activeExperiment.totalBindings > 0) {
      chips.push(
        `${activeExperiment.completedBindings}/${activeExperiment.totalBindings} bindings`,
      );
    }
    const lines = [
      `${spinner} ${style.bold(`${verb} ${targetLabel}`)} ${style.dim(`· ${chips.join(' · ')}`)}`,
    ];
    if (activeBinding) {
      const bindingElapsed = formatDuration(now() - activeBinding.started);
      const detail = activeBinding.detail
        ? ` ${style.dim(`· ${activeBinding.detail}`)}`
        : '';
      lines.push(
        `  ${style.dim('└─')} ${activeBinding.bindingId} ${style.dim(`(${activeBinding.pluginId}) ${bindingElapsed}`)}${detail}`,
      );
    }
    return lines;
  }

  function refreshSticky(): void {
    if (closed || resolvedMode !== 'tty') return;
    renderer.setStatus(buildStickyLines());
  }

  function emitExperimentMilestone(
    entry: WorkspaceCleanupEntry,
    duration: string,
  ): void {
    const id = sanitizeText(entry.experimentId);
    const summary = summarizeResults(entry.results);

    if (entry.status === 'skipped') {
      const reason = sanitizeText(entry.reason);
      if (resolvedMode === 'tty') {
        renderer.printMilestone([
          `${ttyTag('Skipped', style.yellow)}  ${id} ${style.dim(`· ${reason}`)}`,
        ]);
      } else {
        renderer.printMilestone([plainLine(`Skipped ${id}: ${reason}`)]);
      }
      return;
    }

    if (entry.status === 'failed' || entry.status === 'interrupted') {
      const tag = entry.status === 'failed' ? 'Failed' : 'Cancelled';
      const color = entry.status === 'failed' ? style.red : style.yellow;
      const detail = sanitizeText(
        entry.status === 'failed' ? entry.error : entry.reason,
      );
      if (resolvedMode === 'tty') {
        renderer.printMilestone([
          `${ttyTag(tag, color)}  ${id} ${style.dim(`· ${detail}`)}`,
        ]);
      } else {
        renderer.printMilestone([plainLine(`${tag} ${id}: ${detail}`)]);
      }
      return;
    }

    const tag =
      entry.status === 'pending'
        ? 'Pending'
        : entry.status === 'preview'
          ? 'Preview'
          : 'Cleaned';
    const color =
      entry.status === 'pending'
        ? style.yellow
        : entry.status === 'preview'
          ? style.cyan
          : style.green;
    const details = formatResultDetails(summary);
    const meta = [duration, details].filter(Boolean).join(' · ');

    if (resolvedMode === 'tty') {
      const lines = [`${ttyTag(tag, color)}  ${id} ${style.dim(meta)}`];
      for (const err of summary.errors) {
        lines.push(
          `            ${style.red('✗')} ${sanitizeText(err.bindingId)} (${sanitizeText(err.key)}): ${sanitizeText(err.message)}`,
        );
      }
      if (verbose) {
        for (const item of entry.results) {
          if (item.status === 'pending' && item.error) continue;
          const icon =
            item.status === 'complete'
              ? style.green('✓')
              : item.status === 'preview'
                ? style.cyan('○')
                : style.yellow('!');
          lines.push(
            `            ${icon} ${style.dim(`${sanitizeText(item.bindingId)}: ${formatReceiptDetail(item)}`)}`,
          );
        }
      }
      renderer.printMilestone(lines);
      return;
    }

    const dur = duration ? ` in ${duration}` : '';
    const lines = [plainLine(`${tag} ${id}${dur} (${details})`)];
    for (const err of summary.errors) {
      lines.push(
        plainLine(`pending: ${err.bindingId} (${err.key}): ${err.message}`),
      );
    }
    if (verbose) {
      for (const item of entry.results) {
        if (item.status === 'pending' && item.error) continue;
        lines.push(
          plainLine(`${item.bindingId}: ${formatReceiptDetail(item)}`),
        );
      }
    }
    renderer.printMilestone(lines);
  }

  if (resolvedMode === 'tty') {
    renderer.printMilestone([
      `${ttyTag(verb, style.cyan)}  ${targetLabel}${modeSuffix ? style.dim(modeSuffix) : ''}`,
    ]);
    refreshSticky();
  } else {
    const scopePrefix =
      options.scope === 'workspace' ? 'workspace' : `experiment ${targetLabel}`;
    renderer.printMilestone([plainLine(`${verb} ${scopePrefix}${modeSuffix}`)]);
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
  }

  return {
    mode: resolvedMode,
    observe(event) {
      if (closed) return;
      switch (event.kind) {
        case 'experiments-discovered': {
          phase = 'running';
          totalExperiments = event.totalExperiments;
          if (resolvedMode === 'tty') {
            refreshSticky();
          } else {
            const count = `${event.totalExperiments} ${event.totalExperiments === 1 ? 'experiment' : 'experiments'}`;
            renderer.printMilestone([plainLine(`Found ${count} in workspace`)]);
          }
          break;
        }
        case 'experiment-started': {
          phase = 'running';
          totalExperiments = event.total;
          activeExperiment = {
            experimentId: sanitizeText(event.experimentId),
            started: now(),
            totalBindings: 0,
            completedBindings: 0,
          };
          activeBinding = undefined;
          if (resolvedMode === 'tty') {
            refreshSticky();
          } else if (verbose && options.scope === 'workspace') {
            renderer.printMilestone([
              plainLine(
                `${verb} ${event.experimentId} [${event.index + 1}/${event.total}]`,
              ),
            ]);
          }
          break;
        }
        case 'bindings-discovered': {
          phase = 'running';
          if (
            activeExperiment &&
            activeExperiment.experimentId === sanitizeText(event.experimentId)
          ) {
            activeExperiment.totalBindings = event.totalBindings;
          }
          if (resolvedMode === 'tty') {
            refreshSticky();
          } else if (verbose && options.scope === 'experiment') {
            const count = `${event.totalBindings} ${event.totalBindings === 1 ? 'binding' : 'bindings'}`;
            renderer.printMilestone([
              plainLine(`Checking ${count} for ${event.experimentId}`),
            ]);
          }
          break;
        }
        case 'binding-started': {
          phase = 'running';
          if (
            activeExperiment &&
            activeExperiment.experimentId === sanitizeText(event.experimentId)
          ) {
            activeExperiment.totalBindings = event.total;
          }
          const bindingId = sanitizeText(event.bindingId);
          const pluginId = sanitizeText(event.pluginId);
          activeBinding = {
            experimentId: sanitizeText(event.experimentId),
            bindingId,
            pluginId,
            started: now(),
            detail: '',
          };
          if (resolvedMode === 'tty') {
            refreshSticky();
          } else if (verbose) {
            const prefix =
              options.scope === 'workspace' ? `${event.experimentId} · ` : '';
            renderer.printMilestone([
              plainLine(
                `${verb} ${prefix}${bindingId} (${pluginId}) [${event.index + 1}/${event.total}]`,
              ),
            ]);
          }
          break;
        }
        case 'binding-detail': {
          const detail = sanitizeText(event.detail);
          if (!detail) break;
          if (
            activeBinding &&
            activeBinding.experimentId === sanitizeText(event.experimentId) &&
            activeBinding.bindingId === sanitizeText(event.bindingId)
          ) {
            if (activeBinding.detail === detail) break;
            activeBinding.detail = detail;
          }
          if (resolvedMode === 'tty') {
            refreshSticky();
          } else if (verbose) {
            const prefix =
              options.scope === 'workspace'
                ? `${event.experimentId}/${event.bindingId}`
                : event.bindingId;
            renderer.printMilestone([plainLine(`${prefix}: ${detail}`)]);
          }
          break;
        }
        case 'binding-completed': {
          const duration = activeBinding
            ? formatDuration(now() - activeBinding.started)
            : '';
          activeBinding = undefined;
          if (
            activeExperiment &&
            activeExperiment.experimentId === sanitizeText(event.experimentId)
          ) {
            activeExperiment.completedBindings = Math.max(
              activeExperiment.completedBindings,
              event.index + 1,
            );
          }

          if (options.scope === 'workspace') {
            refreshSticky();
            break;
          }

          const bindingId = sanitizeText(event.bindingId);
          const pluginId = sanitizeText(event.pluginId);
          if (!event.handled) {
            if (verbose) {
              if (resolvedMode === 'tty') {
                renderer.printMilestone([
                  `${ttyTag('Skipped')}  ${bindingId} ${style.dim(`(${pluginId}) · no cleanup handler`)}`,
                ]);
              } else {
                renderer.printMilestone([
                  plainLine(
                    `Skipped ${bindingId} (${pluginId}): no cleanup handler`,
                  ),
                ]);
              }
            }
            refreshSticky();
            break;
          }

          const summary = summarizeResults(event.results);
          const tag =
            summary.pending > 0
              ? 'Pending'
              : options.dryRun
                ? 'Preview'
                : 'Cleaned';
          const color =
            summary.pending > 0
              ? style.yellow
              : options.dryRun
                ? style.cyan
                : style.green;
          const details = formatResultDetails(summary);

          if (resolvedMode === 'tty') {
            const meta = [duration, details].filter(Boolean).join(' · ');
            const lines = [
              `${ttyTag(tag, color)}  ${bindingId} ${style.dim(`(${pluginId}) ${meta}`)}`,
            ];
            for (const err of summary.errors) {
              lines.push(
                `            ${style.red('✗')} ${sanitizeText(err.key)}: ${sanitizeText(err.message)}`,
              );
            }
            if (verbose) {
              for (const item of event.results) {
                if (item.status === 'pending' && item.error) continue;
                const icon =
                  item.status === 'complete'
                    ? style.green('✓')
                    : item.status === 'preview'
                      ? style.cyan('○')
                      : style.yellow('!');
                lines.push(
                  `            ${icon} ${style.dim(formatReceiptDetail(item))}`,
                );
              }
            }
            renderer.printMilestone(lines);
            refreshSticky();
          } else {
            const dur = duration ? ` in ${duration}` : '';
            const lines = [
              plainLine(`${tag} ${bindingId} (${pluginId})${dur} (${details})`),
            ];
            for (const err of summary.errors) {
              lines.push(plainLine(`pending: ${err.key}: ${err.message}`));
            }
            if (verbose) {
              for (const item of event.results) {
                if (item.status === 'pending' && item.error) continue;
                lines.push(plainLine(formatReceiptDetail(item)));
              }
            }
            renderer.printMilestone(lines);
          }
          break;
        }
        case 'experiment-completed': {
          const duration = activeExperiment
            ? formatDuration(now() - activeExperiment.started)
            : '';
          activeBinding = undefined;
          activeExperiment = undefined;
          completedExperiments = Math.max(
            completedExperiments,
            event.index + 1,
          );
          if (options.scope === 'workspace') {
            emitExperimentMilestone(event.entry, duration);
            refreshSticky();
          }
          break;
        }
        case 'finished': {
          if (event.scope === 'experiment') {
            finalExperimentReport = event.report;
          } else {
            finalWorkspaceReport = event.report;
          }
          break;
        }
      }
    },
    finish(status, error) {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      activeBinding = undefined;
      activeExperiment = undefined;
      const total = elapsedText();
      const cancelled = status === 'cancelled';
      const summaryLabel = cancelled ? 'Cancelled' : 'Summary';

      if (finalExperimentReport) {
        const summary = summarizeResults(finalExperimentReport.results);
        const outcome =
          summary.pending > 0
            ? 'pending'
            : finalExperimentReport.dryRun
              ? 'preview'
              : 'complete';
        const details =
          summary.total === 0
            ? 'nothing to clean'
            : `${outcome} · ${formatResultDetails(summary)}`;
        if (resolvedMode === 'tty') {
          const color =
            cancelled || summary.pending > 0
              ? style.yellow
              : finalExperimentReport.dryRun
                ? style.cyan
                : style.green;
          renderer.finish([
            `${ttyTag(summaryLabel, color)}  ${details} ${style.dim(`in ${total}`)}`,
          ]);
        } else {
          renderer.finish([plainLine(`${summaryLabel} ${details}`)]);
        }
        return;
      }

      if (finalWorkspaceReport) {
        const { experiments, dryRun } = finalWorkspaceReport;
        const counts = {
          complete: 0,
          preview: 0,
          pending: 0,
          skipped: 0,
          failed: 0,
          interrupted: 0,
        };
        const allResults: BindingCleanupResult[] = [];
        for (const entry of experiments) {
          counts[entry.status] += 1;
          allResults.push(...entry.results);
        }
        const statusParts: string[] = [];
        if (counts.complete > 0)
          statusParts.push(`${counts.complete} complete`);
        if (counts.preview > 0) statusParts.push(`${counts.preview} preview`);
        if (counts.pending > 0) statusParts.push(`${counts.pending} pending`);
        if (counts.skipped > 0) statusParts.push(`${counts.skipped} skipped`);
        if (counts.failed > 0) statusParts.push(`${counts.failed} failed`);
        if (counts.interrupted > 0)
          statusParts.push(`${counts.interrupted} interrupted`);
        const expCount = `${experiments.length} ${experiments.length === 1 ? 'experiment' : 'experiments'}`;
        const expText = statusParts.length
          ? `${expCount} (${statusParts.join(' · ')})`
          : expCount;
        const imageParts = formatImageParts(
          summarizeResults(allResults).images,
        );
        const summaryText = [expText, ...imageParts].join(' · ');

        if (resolvedMode === 'tty') {
          const color = cancelled
            ? style.yellow
            : counts.failed > 0
              ? style.red
              : counts.pending > 0 || counts.interrupted > 0
                ? style.yellow
                : dryRun
                  ? style.cyan
                  : style.green;
          renderer.finish([
            `${ttyTag(summaryLabel, color)}  ${summaryText} ${style.dim(`in ${total}`)}`,
          ]);
        } else {
          renderer.finish([plainLine(`${summaryLabel} ${summaryText}`)]);
        }
        return;
      }

      const normalizedError = error ? sanitizeText(error) : '';
      if (normalizedError) {
        options.onErrorReported?.(normalizedError);
      }
      const suffix = normalizedError ? `: ${normalizedError}` : '';
      if (resolvedMode === 'tty') {
        const color = status === 'cancelled' ? style.yellow : style.red;
        const label = status === 'cancelled' ? 'Cancelled' : 'Failed';
        renderer.finish([
          `${ttyTag(label, color)}  Cleanup ${status}${suffix} ${style.dim(`in ${total}`)}`,
        ]);
      } else {
        renderer.finish([plainLine(`Cleanup ${status}${suffix}`)]);
      }
    },
  };
}
