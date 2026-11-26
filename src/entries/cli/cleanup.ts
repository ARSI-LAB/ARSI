import { getLogger } from '@logtape/logtape';
import {
  collectExperimentCleanup,
  ExperimentInUseError,
  type ExperimentCleanupReport,
} from '../../runtime/manager/cleanup.js';
import type { Manager } from '../../runtime/manager/index.js';
import { FileFacts } from '../../runtime/storage/index.js';
import { errorText } from '../../shared/errors.js';
import { string } from '../../shared/json.js';

const logger = getLogger(['arsi', 'runtime', 'cleanup']);

type WorkspaceCleanupEntry = Pick<
  ExperimentCleanupReport,
  'experimentId' | 'results'
> &
  (
    | { status: 'complete' | 'pending' | 'preview' }
    | { status: 'skipped' | 'interrupted'; reason: string }
    | { status: 'failed'; error: string }
  );

export async function cleanupExperiment(
  manager: Manager,
  experimentId: string,
  dryRun: boolean,
  signal: AbortSignal,
): Promise<ExperimentCleanupReport> {
  const report: ExperimentCleanupReport = { experimentId, dryRun, results: [] };
  await collectExperimentCleanup(manager, report, signal);
  return report;
}

/** Inspect each experiment independently so a busy or damaged one cannot block its peers. */
export async function cleanupWorkspace(
  manager: Manager,
  dryRun: boolean,
  signal: AbortSignal,
): Promise<{ dryRun: boolean; experiments: WorkspaceCleanupEntry[] }> {
  const experiments: WorkspaceCleanupEntry[] = [];
  const ids =
    manager.facts instanceof FileFacts
      ? await manager.facts.listIds('experiments')
      : (await manager.list()).map((record) =>
          string(record.id, 'experiment ID'),
        );
  for (const experimentId of ids) {
    if (signal.aborted) break;
    const report: ExperimentCleanupReport = {
      experimentId,
      dryRun,
      results: [],
    };
    try {
      await collectExperimentCleanup(manager, report, signal);
      signal.throwIfAborted();
      const { results } = report;
      const status = results.some((entry) => entry.status === 'pending')
        ? 'pending'
        : dryRun
          ? 'preview'
          : 'complete';
      experiments.push({ experimentId, results, status });
    } catch (error) {
      const entry = { experimentId, results: report.results };
      if (signal.aborted)
        experiments.push({
          ...entry,
          status: 'interrupted',
          reason: errorText(signal.reason),
        });
      else if (error instanceof ExperimentInUseError) {
        experiments.push({
          ...entry,
          status: 'skipped',
          reason: error.message,
        });
        logger.warn('{reason}', {
          stage: 'Skipped',
          experimentId,
          reason: error.message,
        });
      } else {
        experiments.push({
          ...entry,
          status: 'failed',
          error: errorText(error),
        });
        logger.error('cleanup {experimentId}', {
          stage: 'Failed',
          experimentId,
          error,
        });
      }
    }
  }
  const counts = {
    complete: 0,
    preview: 0,
    pending: 0,
    skipped: 0,
    interrupted: 0,
    failed: 0,
  };
  for (const { status } of experiments) counts[status]++;
  logger.info(
    'workspace {mode} cleaned={complete} previewed={preview} pending={pending} skipped={skipped} interrupted={interrupted} failed={failed}',
    {
      stage: 'Completed',
      mode: dryRun ? 'preview' : 'cleanup',
      ...counts,
    },
  );
  return { dryRun, experiments };
}
