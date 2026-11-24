import type { DoctorCheck, DoctorReport } from '../../contracts/index.js';
import type { DoctorProgressReporter } from '../../runtime/doctor/progress.js';
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

export interface DoctorProgressOptions {
  stream: ProgressStream;
  recipe: string;
  staticOnly: boolean;
  mode?: ProgressMode;
  verbose?: boolean;
  tickMs?: number;
  now?: () => number;
}

export interface DoctorProgressOutput {
  readonly mode: ResolvedProgressMode;
  observe: DoctorProgressReporter;
  finish(status: 'completed' | 'cancelled' | 'failed'): void;
}

function padTag(label: string): string {
  return label.padStart(10);
}

function formatCounts(
  passed: number,
  failed: number,
  unchecked: number,
): string {
  const parts: string[] = [];
  if (passed > 0) parts.push(`${passed} passed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (unchecked > 0) parts.push(`${unchecked} unchecked`);
  return parts.join(' · ') || '0 checks';
}

function formatCheckReason(check: DoctorCheck): string {
  const id = sanitizeText(check.id);
  const reason = check.reason ? sanitizeText(check.reason) : '';
  return reason ? `${id}: ${reason}` : id;
}

export function startDoctorProgress(
  options: DoctorProgressOptions,
): DoctorProgressOutput {
  const now = options.now ?? (() => performance.now());
  const resolvedMode = resolveProgressMode(
    options.mode ?? 'auto',
    options.stream,
  );
  const verbose = options.verbose === true;
  const renderer = createTerminalRenderer(options.stream, resolvedMode);
  const { style } = renderer;

  const started = now();
  const recipeLabel = sanitizeText(options.recipe);
  let phase: 'loading' | 'checking' | 'cleaning' = 'loading';
  let totalBindings = 0;
  let completedBindings = 0;
  let activeBinding:
    | {
        binding: string;
        pluginId: string;
        started: number;
        detail: string;
      }
    | undefined;
  let finalReport: DoctorReport | undefined;
  let frame = 0;
  let closed = false;

  function elapsedText(): string {
    return formatDuration(now() - started);
  }

  function plainLine(message: string): string {
    return `[arsi doctor +${elapsedText()}] ${sanitizeText(message)}`;
  }

  function ttyTag(label: string, color?: (text: string) => string): string {
    const padded = padTag(label);
    return color ? style.bold(color(padded)) : style.dim(padded);
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
    const chips = [elapsedText()];
    if (totalBindings > 0) {
      chips.push(`${completedBindings}/${totalBindings} bindings`);
    }
    const lines = [
      `${spinner} ${style.bold('Checking')} ${style.dim(`· ${chips.join(' · ')}`)}`,
    ];
    if (activeBinding) {
      const bindingElapsed = formatDuration(now() - activeBinding.started);
      const detail = activeBinding.detail
        ? ` ${style.dim(`· ${activeBinding.detail}`)}`
        : '';
      lines.push(
        `  ${style.dim('└─')} ${activeBinding.binding} ${style.dim(`(${activeBinding.pluginId}) ${bindingElapsed}`)}${detail}`,
      );
    }
    return lines;
  }

  function refreshSticky(): void {
    if (closed || resolvedMode !== 'tty') return;
    renderer.setStatus(buildStickyLines());
  }

  const staticSuffix = options.staticOnly ? ' (static)' : '';
  if (resolvedMode === 'tty') {
    renderer.printMilestone([
      `${ttyTag('Checking', style.cyan)}  ${recipeLabel}${staticSuffix ? style.dim(staticSuffix) : ''}`,
    ]);
    refreshSticky();
  } else {
    renderer.printMilestone([
      plainLine(`Checking Recipe ${recipeLabel}${staticSuffix}`),
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
  }

  return {
    mode: resolvedMode,
    observe(event) {
      if (closed) return;
      switch (event.kind) {
        case 'recipe-validated': {
          phase = 'checking';
          totalBindings = event.totalBindings;
          const recipeId = sanitizeText(event.recipeId);
          const count = `${event.totalBindings} ${event.totalBindings === 1 ? 'binding' : 'bindings'}`;
          if (resolvedMode === 'tty') {
            renderer.printMilestone([
              `${ttyTag('Validated', style.green)}  ${recipeId} ${style.dim(`(${count})`)}`,
            ]);
            refreshSticky();
          } else {
            renderer.printMilestone([
              plainLine(`Validated Recipe ${recipeId} (${count})`),
            ]);
          }
          break;
        }
        case 'binding-started': {
          phase = 'checking';
          totalBindings = event.total;
          const binding = sanitizeText(event.binding);
          const pluginId = sanitizeText(event.pluginId);
          activeBinding = {
            binding,
            pluginId,
            started: now(),
            detail: '',
          };
          if (resolvedMode === 'tty') {
            refreshSticky();
          } else if (verbose) {
            renderer.printMilestone([
              plainLine(
                `Checking ${binding} (${pluginId}) [${event.index + 1}/${event.total}]`,
              ),
            ]);
          }
          break;
        }
        case 'binding-detail': {
          const detail = sanitizeText(event.detail);
          if (!detail) break;
          if (activeBinding && activeBinding.binding === event.binding) {
            if (activeBinding.detail === detail) break;
            activeBinding.detail = detail;
          }
          if (resolvedMode === 'tty') {
            refreshSticky();
          } else if (verbose) {
            renderer.printMilestone([
              plainLine(`${sanitizeText(event.binding)}: ${detail}`),
            ]);
          }
          break;
        }
        case 'binding-completed': {
          const duration = activeBinding
            ? formatDuration(now() - activeBinding.started)
            : '';
          activeBinding = undefined;
          completedBindings = Math.max(completedBindings, event.index + 1);
          const binding = sanitizeText(event.binding);
          const pluginId = sanitizeText(event.pluginId);
          const counts = formatCounts(
            event.passed,
            event.failed,
            event.unchecked,
          );
          const status =
            event.failed > 0
              ? 'Failed'
              : event.passed === 0 && event.unchecked > 0
                ? 'Unchecked'
                : 'Passed';

          if (resolvedMode === 'tty') {
            const color =
              status === 'Failed'
                ? style.red
                : status === 'Unchecked'
                  ? style.yellow
                  : style.green;
            const meta = [duration, counts].filter(Boolean).join(' · ');
            const lines = [
              `${ttyTag(status, color)}  ${binding} ${style.dim(`(${pluginId}) ${meta}`)}`,
            ];
            for (const check of event.checks) {
              if (check.status === 'failed') {
                lines.push(
                  `            ${style.red('✗')} ${formatCheckReason(check)}`,
                );
              } else if (verbose) {
                const icon =
                  check.status === 'passed'
                    ? style.green('✓')
                    : style.yellow('○');
                lines.push(
                  `            ${icon} ${style.dim(formatCheckReason(check))}`,
                );
              }
            }
            renderer.printMilestone(lines);
            refreshSticky();
          } else {
            const dur = duration ? ` in ${duration}` : '';
            const lines = [
              plainLine(`${status} ${binding} (${pluginId})${dur} (${counts})`),
            ];
            for (const check of event.checks) {
              if (check.status === 'failed') {
                lines.push(plainLine(`fail: ${formatCheckReason(check)}`));
              } else if (verbose) {
                lines.push(
                  plainLine(`${check.status}: ${formatCheckReason(check)}`),
                );
              }
            }
            renderer.printMilestone(lines);
          }
          break;
        }
        case 'cleaning': {
          phase = 'cleaning';
          activeBinding = undefined;
          refreshSticky();
          break;
        }
        case 'finished':
          finalReport = event.report;
          break;
      }
    },
    finish(status) {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      activeBinding = undefined;
      const total = elapsedText();

      if (!finalReport) {
        if (resolvedMode === 'tty') {
          const color = status === 'cancelled' ? style.yellow : style.red;
          const label = status === 'cancelled' ? 'Cancelled' : 'Failed';
          renderer.finish([
            `${ttyTag(label, color)}  Doctor ${status} ${style.dim(`in ${total}`)}`,
          ]);
        } else {
          renderer.finish([plainLine(`Doctor ${status}`)]);
        }
        return;
      }

      const { passed, failed, unchecked } = finalReport.summary;
      const summaryCounts = `${passed} passed · ${failed} failed · ${unchecked} unchecked`;
      const topLevelFailures = finalReport.checks.filter(
        (check) => check.status === 'failed' && !check.binding,
      );
      const missingCount = finalReport.missingResources.length;

      if (resolvedMode === 'tty') {
        const lines: string[] = [];
        for (const check of topLevelFailures) {
          lines.push(
            `${ttyTag('Failed', style.red)}  ${formatCheckReason(check)}`,
          );
        }
        const summaryColor = failed > 0 ? style.red : style.green;
        lines.push(
          `${ttyTag('Summary', summaryColor)}  ${summaryCounts} ${style.dim(`in ${total}`)}`,
        );
        if (missingCount > 0) {
          const shown = verbose
            ? finalReport.missingResources
            : finalReport.missingResources.slice(0, 3);
          const extra =
            missingCount > shown.length
              ? ` (+${missingCount - shown.length} more)`
              : '';
          lines.push(
            `${ttyTag('Missing', style.yellow)}  ${missingCount} missing ${missingCount === 1 ? 'resource' : 'resources'}${style.dim(extra)}`,
          );
          for (const res of shown) {
            lines.push(
              `            ${style.dim(`${sanitizeText(res.field)}: ${sanitizeText(res.reference)}`)}`,
            );
          }
        }
        renderer.finish(lines);
        return;
      }

      const lines: string[] = [];
      for (const check of topLevelFailures) {
        lines.push(plainLine(`Failed ${formatCheckReason(check)}`));
      }
      lines.push(plainLine(`Summary ${summaryCounts}`));
      if (missingCount > 0) {
        lines.push(
          plainLine(
            `Missing ${missingCount} ${missingCount === 1 ? 'resource' : 'resources'}`,
          ),
        );
      }
      renderer.finish(lines);
    },
  };
}
