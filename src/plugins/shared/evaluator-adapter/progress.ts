import type { ProgressEvent, ProgressListener } from 'arsi-evaluator';
import type { RuntimeContext } from '../../../contracts/index.js';
import { summarizeSdkDiagnostic } from './progress-diagnostics.js';

const maxFinishedEntries = 256;
const maxMultiTaskLines = 4;
const displayedPhases = new Set([
  'bootstrap',
  'cleanup',
  'collect',
  'config',
  'deployment',
  'dispose',
  'enumerate',
  'environment',
  'execution',
  'install',
  'prepare',
  'progress',
  'report',
  'resume',
  'retry',
  'solve',
  'source',
  'store',
  'task',
  'transfer',
  'verify',
]);

function taskLabel(id: string | undefined): string {
  if (!id || id.length > 256 || /[^\w./:@+-]/.test(id)) return '';
  return id.length > 80 ? `${id.slice(0, 79)}…` : id;
}

function isCount(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function formatMs(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60_000) return `${(safe / 1000).toFixed(0)}s`;
  const totalSec = Math.floor(safe / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

interface TrackedTask {
  readonly taskId?: string;
  readonly sequence: number;
  task: string;
  phase: string;
  elapsedMs?: number;
  updatedAt: number;
}

/**
 * Forward `arsi-evaluator` SDK progress events to the active Runtime call's
 * presentation-only progress channel without persisting them as facts.
 */
export function forwardSdkProgress(
  context: RuntimeContext,
): ProgressListener | undefined {
  const report = context.reportProgress;
  if (!report) return undefined;

  let lastSummary:
    | { total: number; prepared: number; completed: number }
    | undefined;
  let lastTaskFraction = '';
  let lastPhase = '';
  let tick = 0;
  const active = new Map<string, TrackedTask>();
  const finished = new Set<string>();

  function buildHeaderDetail(): string {
    const parts: string[] = [];
    if (lastSummary && lastSummary.total > 0) {
      const prep =
        lastSummary.prepared > lastSummary.completed &&
        lastSummary.prepared < lastSummary.total
          ? ` (${lastSummary.prepared} prepared)`
          : '';
      parts.push(`${lastSummary.completed}/${lastSummary.total} done${prep}`);
    } else if (lastTaskFraction) {
      parts.push(lastTaskFraction);
    }
    if (parts.length === 0 && lastPhase) parts.push(lastPhase);
    return parts.join(' · ');
  }

  function buildDetailLines(): string[] {
    const seenTasks = new Set<string>();
    const entries = [...active.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter(({ taskId }) => {
        if (taskId === undefined) return true;
        if (seenTasks.has(taskId)) return false;
        seenTasks.add(taskId);
        return true;
      });
    const lines: string[] = [];
    const shown = entries.slice(0, maxMultiTaskLines);
    for (const item of shown) {
      const prefix = `[${item.phase || 'evaluation'}]`;
      const name = item.task ? ` ${item.task}` : '';
      const timeSuffix =
        item.elapsedMs !== undefined && item.elapsedMs >= 1000
          ? ` (${formatMs(item.elapsedMs)})`
          : '';
      lines.push(`${prefix}${name}${timeSuffix}`);
    }
    if (entries.length > shown.length) {
      lines.push(`+${entries.length - shown.length} more active tasks`);
    }
    return lines;
  }

  return (event: ProgressEvent): void => {
    const live = event.live;
    const existing = live ? active.get(live.id) : undefined;
    if (
      live &&
      (finished.has(live.id) || (existing && live.sequence < existing.sequence))
    )
      return;
    tick += 1;
    const { summary, taskNumber, taskTotal } = event;
    if (
      summary &&
      isCount(summary.total) &&
      isCount(summary.prepared) &&
      isCount(summary.completed)
    )
      lastSummary = {
        total: summary.total,
        prepared: summary.prepared,
        completed: summary.completed,
      };
    if (isCount(taskNumber) && isCount(taskTotal) && taskTotal > 0) {
      lastTaskFraction = `${taskNumber}/${taskTotal}`;
    }

    // Live SDK text can contain tool inputs or outputs. Render task metadata.
    const phase = displayedPhases.has(event.phase) ? event.phase : '';
    const task = taskLabel(event.taskId);
    if (phase) lastPhase = phase;

    if (live) {
      if (
        live.status === 'completed' ||
        live.status === 'failed' ||
        live.status === 'cancelled'
      ) {
        active.delete(live.id);
        finished.add(live.id);
        if (finished.size > maxFinishedEntries)
          finished.delete(finished.values().next().value!);
      } else {
        const parent = live.parentId ? active.get(live.parentId) : undefined;
        active.set(live.id, {
          taskId: event.taskId ?? existing?.taskId ?? parent?.taskId,
          sequence: live.sequence,
          task: task || existing?.task || parent?.task || '',
          phase: phase || existing?.phase || '',
          elapsedMs: Number.isFinite(live.elapsedMs)
            ? live.elapsedMs
            : undefined,
          updatedAt: tick,
        });
      }
    }

    const detail = buildHeaderDetail();
    const lines = buildDetailLines();
    const level =
      event.error === true
        ? 'error'
        : event.warning === true
          ? 'warning'
          : undefined;

    if (level) {
      const failurePhase = event.failure?.phase;
      const diagnostic = summarizeSdkDiagnostic(
        event,
        failurePhase && displayedPhases.has(failurePhase)
          ? failurePhase
          : phase,
      );
      const prefix = task ? `${task}: ` : phase ? `${phase}: ` : '';
      report.call(context, {
        ...(detail ? { detail } : {}),
        lines,
        ...diagnostic,
        notice: `${prefix}${diagnostic.notice}`,
        level,
      });
      return;
    }

    if (detail || live || lines.length > 0) {
      report.call(context, {
        ...(detail ? { detail } : {}),
        lines,
      });
    }
  };
}
