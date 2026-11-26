import { getLogger } from '@logtape/logtape';
import type {
  EvaluatorRunOptions,
  LiveProgress,
  ProgressListener,
} from 'arsi-evaluator';
import type { RuntimeContext } from '../../../contracts/index.js';
import { reportTaskProgress } from '../../../shared/task-progress.js';
import {
  recordCleanupInput,
  type EvaluatorCleanupRegistration,
} from './cleanup.js';

const logger = getLogger(['arsi', 'plugin', 'evaluator']);

export type SdkRunOptions = EvaluatorRunOptions;
interface SdkRunContext {
  context: RuntimeContext;
  cleanup?: EvaluatorCleanupRegistration;
}
export type EvaluatorRunner = (
  options: SdkRunOptions,
  run?: SdkRunContext,
) => Promise<unknown>;
export async function sdkRunner(
  options: SdkRunOptions,
  run?: SdkRunContext,
): Promise<unknown> {
  const sdk = await import('arsi-evaluator');
  if (run?.cleanup)
    await recordCleanupInput(
      { context: run.context, ...run.cleanup },
      options.configPath,
      options.env ?? process.env,
    );
  const evaluator = new sdk.Evaluator();
  if (!run || !logger.isEnabledFor('error')) return evaluator.run(options);
  const reportProgress = evaluatorProgress(run.context);
  return evaluator.run({
    ...options,
    onProgress(event) {
      options.onProgress?.(event);
      reportProgress(event);
    },
  });
}

interface ActivePhase {
  phase: string;
  live?: Pick<LiveProgress, 'id' | 'sequence' | 'idleMs'>;
}

const taskFinish =
  /^Finished:\s*([^;]+)(?:;\s*score=([^;]+))?(?:;\s*progress\s+(\d+)\/(\d+))?/;

function evaluatorProgress({
  experimentId,
  bindingId,
  callId,
}: RuntimeContext): ProgressListener {
  const active = new Map<string, ActivePhase>();
  const prepared = new Set<string>();
  const completed = new Set<string>();
  const seenOutcomes = new Set<string>();
  const seenPhases = new Set<string>();
  const seenDiagnostics = new Set<string>();
  let total: number | undefined;
  let global: { phase: string; detail: string } | undefined;
  let previousDetail: string | undefined;

  return (event) => {
    const {
      taskId: caseId,
      attemptId,
      phase,
      live,
      message,
      summary,
      transient,
    } = event;
    const attempt = JSON.stringify([caseId, attemptId]);
    const diagnostic = event.error || event.warning;
    const finished =
      !transient && phase === 'task' && caseId
        ? taskFinish.exec(message)
        : null;
    if (finished && seenOutcomes.has(attempt)) return;
    total =
      summary?.total ??
      event.taskTotal ??
      (finished?.[4] ? Number(finished[4]) : total);

    if (caseId) {
      if (live?.status === 'completed' && live.preparation)
        prepared.add(caseId);
      if (finished) {
        seenOutcomes.add(attempt);
        completed.add(caseId);
        active.delete(caseId);
      } else if (
        !diagnostic &&
        !event.connection &&
        !seenOutcomes.has(attempt) &&
        !live?.parentId
      ) {
        const current = active.get(caseId);
        if (live && live.status !== 'started' && live.status !== 'updated') {
          if (current?.live?.id === live.id) active.delete(caseId);
        } else if (
          live
            ? current?.live?.id !== live.id ||
              current.live.sequence < live.sequence
            : !transient && !current?.live
        ) {
          global = undefined;
          completed.delete(caseId);
          if (phase === 'solve' || phase === 'verify') prepared.add(caseId);
          active.set(caseId, {
            phase,
            ...(live && {
              live: {
                id: live.id,
                sequence: live.sequence,
                idleMs: live.idleMs,
              },
            }),
          });
        }
      }
    } else if (!diagnostic && !event.connection && !live?.parentId) {
      if (
        live?.status === 'started' ||
        live?.status === 'updated' ||
        (!transient && !live)
      )
        global = { phase, detail: `[${phase}] ${message}` };
      else if (live && global?.phase === phase) global = undefined;
    }

    const done =
      summary?.completed ??
      (finished?.[3] ? Number(finished[3]) : completed.size);
    const limit = total ?? '?';
    const counts = `ready ${summary?.prepared ?? prepared.size}/${limit} · done ${done}/${limit}`;
    let detail = global?.detail ?? (total === undefined ? '' : counts);
    if (active.size === 1) {
      const [id, task] = active.entries().next().value!;
      const idle = task.live?.idleMs ?? 0;
      detail = `done ${done}/${limit} · ${id} [${task.phase}]${idle >= 60_000 ? ` · idle ${Math.floor(idle / 1000)}s` : ''}`;
    } else if (active.size > 1) {
      const tasks = [...active.values()];
      const solving = tasks.filter((task) => task.phase === 'solve').length;
      const verifying = tasks.filter((task) => task.phase === 'verify').length;
      detail = `${counts} · solving ${solving} · verifying ${verifying}`;
    }
    if (detail !== previousDetail) {
      previousDetail = detail;
      reportTaskProgress(logger, callId, detail);
    }

    if (transient || event.connection) return;
    const label = caseId ? `${bindingId} ${caseId}` : bindingId;
    const fields = {
      experimentId,
      bindingId,
      callId,
      caseId,
      attemptId,
      phase,
      label,
      summary: message,
    };
    if (diagnostic) {
      const code = event.failure?.code;
      const key = JSON.stringify([caseId, attemptId, phase, code, message]);
      if (seenDiagnostics.has(key)) return;
      seenDiagnostics.add(key);
      if (event.error)
        logger.error('{label}: {summary}', { ...fields, code, stage: 'Error' });
      else
        logger.warn('{label}: {summary}', {
          ...fields,
          code,
          stage: phase === 'retry' && caseId ? 'Retrying' : 'Warning',
        });
    } else if (finished) {
      logger.info('{bindingId} · {position} {caseId} {status}{score}', {
        ...fields,
        stage: 'Progress',
        position: `${done}/${limit}`,
        status: finished[1]!.trim(),
        score: finished[2] ? ` · score=${finished[2].trim()}` : '',
      });
    } else {
      const key = JSON.stringify([caseId, attemptId, phase]);
      if (seenPhases.has(key)) return;
      seenPhases.add(key);
      logger.debug('{label} [{phase}] {summary}', fields);
    }
  };
}
