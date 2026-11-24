import {
  collectExperimentCleanup,
  ExperimentInUseError,
  type CleanupBindingProgress,
  type ExperimentCleanupReport,
} from '../../runtime/manager/cleanup.js';
import type { Manager } from '../../runtime/manager/index.js';
import { FileFacts } from '../../runtime/storage/index.js';
import { errorText } from '../../shared/errors.js';
import { string } from '../../shared/json.js';

export type WorkspaceCleanupEntry = Pick<
  ExperimentCleanupReport,
  'experimentId' | 'results'
> &
  (
    | { status: 'complete' | 'pending' | 'preview' }
    | { status: 'skipped' | 'interrupted'; reason: string }
    | { status: 'failed'; error: string }
  );

export interface WorkspaceCleanupReport {
  dryRun: boolean;
  experiments: WorkspaceCleanupEntry[];
}

export type CleanupProgress =
  | CleanupBindingProgress
  | {
      readonly kind: 'experiments-discovered';
      readonly totalExperiments: number;
    }
  | {
      readonly kind: 'experiment-started';
      readonly experimentId: string;
      readonly index: number;
      readonly total: number;
    }
  | {
      readonly kind: 'experiment-completed';
      readonly index: number;
      readonly total: number;
      readonly entry: WorkspaceCleanupEntry;
    }
  | {
      readonly kind: 'finished';
      readonly scope: 'experiment';
      readonly report: ExperimentCleanupReport;
    }
  | {
      readonly kind: 'finished';
      readonly scope: 'workspace';
      readonly report: WorkspaceCleanupReport;
    };

export type CleanupCliProgressObserver = (
  event: CleanupProgress,
) => void | Promise<void>;

function notifyProgress(
  observe: CleanupCliProgressObserver | undefined,
  event: CleanupProgress,
): void {
  if (!observe) return;
  try {
    const pending = observe(structuredClone(event));
    if (pending) void pending.catch(() => {});
  } catch {
    // Reporting is best effort.
  }
}

export async function cleanupExperiment(
  manager: Manager,
  experimentId: string,
  dryRun: boolean,
  signal: AbortSignal,
  onProgress?: CleanupCliProgressObserver,
): Promise<ExperimentCleanupReport> {
  const report: ExperimentCleanupReport = { experimentId, dryRun, results: [] };
  notifyProgress(onProgress, {
    kind: 'experiment-started',
    experimentId,
    index: 0,
    total: 1,
  });
  await collectExperimentCleanup(manager, report, signal, onProgress);
  notifyProgress(onProgress, { kind: 'finished', scope: 'experiment', report });
  return report;
}

/** Inspect each experiment independently so a busy or damaged one cannot block its peers. */
export async function cleanupWorkspace(
  manager: Manager,
  dryRun: boolean,
  signal: AbortSignal,
  onProgress?: CleanupCliProgressObserver,
): Promise<WorkspaceCleanupReport> {
  const experiments: WorkspaceCleanupEntry[] = [];
  const ids =
    manager.facts instanceof FileFacts
      ? await manager.facts.listIds('experiments')
      : (await manager.list()).map((record) =>
          string(record.id, 'experiment ID'),
        );
  notifyProgress(onProgress, {
    kind: 'experiments-discovered',
    totalExperiments: ids.length,
  });
  for (const [index, experimentId] of ids.entries()) {
    if (signal.aborted) break;
    notifyProgress(onProgress, {
      kind: 'experiment-started',
      experimentId,
      index,
      total: ids.length,
    });
    const report: ExperimentCleanupReport = {
      experimentId,
      dryRun,
      results: [],
    };
    let completed: WorkspaceCleanupEntry;
    try {
      await collectExperimentCleanup(manager, report, signal, onProgress);
      signal.throwIfAborted();
      const { results } = report;
      const status = results.some((entry) => entry.status === 'pending')
        ? 'pending'
        : dryRun
          ? 'preview'
          : 'complete';
      completed = { experimentId, results, status };
    } catch (error) {
      const entry = { experimentId, results: report.results };
      if (signal.aborted)
        completed = {
          ...entry,
          status: 'interrupted',
          reason: errorText(signal.reason),
        };
      else if (error instanceof ExperimentInUseError)
        completed = {
          ...entry,
          status: 'skipped',
          reason: error.message,
        };
      else
        completed = {
          ...entry,
          status: 'failed',
          error: errorText(error),
        };
    }
    experiments.push(completed);
    notifyProgress(onProgress, {
      kind: 'experiment-completed',
      index,
      total: ids.length,
      entry: completed,
    });
  }
  const summary: WorkspaceCleanupReport = { dryRun, experiments };
  notifyProgress(onProgress, {
    kind: 'finished',
    scope: 'workspace',
    report: summary,
  });
  return summary;
}
