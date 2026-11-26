import type { JsonObject } from '../../../contracts/index.js';
import type { Manager } from '../../../runtime/manager/index.js';
import {
  currentPreparedRunId,
  setRunLogRedactor,
  showsCargoRunDetails,
} from '../logging/index.js';
import { createResumeReport, reportRunSummary } from './report.js';

interface ExecuteRunOptions {
  id?: string;
  resume: boolean;
  signal: AbortSignal;
  logging: boolean;
}

export async function executeRun(
  manager: Manager,
  recipePath: string,
  { id, resume, signal, logging }: ExecuteRunOptions,
): Promise<JsonObject> {
  const showDetails = showsCargoRunDetails();
  const options = {
    id,
    resume,
    signal,
    ...(logging && { onLogRedactor: setRunLogRedactor }),
  };
  if (!showDetails) return manager.run(recipePath, options);

  const replay = resume ? createResumeReport(manager) : undefined;
  let finished: JsonObject | undefined;
  try {
    finished = await manager.run(recipePath, {
      ...options,
      ...(replay && { onReusedCalls: replay.onReusedCalls }),
    });
    replay?.restoreCompleted(finished);
    return finished;
  } finally {
    if (replay) await replay.finish();
    const experimentId =
      typeof finished?.id === 'string' ? finished.id : currentPreparedRunId();
    if (experimentId)
      await reportRunSummary(manager, experimentId, finished).catch(() => {});
  }
}
