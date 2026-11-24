import type { DoctorReport } from '../../contracts/index.js';
import { RuntimeCleanupInterruptedError } from '../../shared/errors.js';
import type { Runtime } from '../context.js';
import { doctorFailure, doctorRecipe } from './index.js';
import {
  doctorProgressReporter,
  type DoctorProgressObserver,
} from './progress.js';

/** The caller owns the Runtime if diagnosis throws before releasing it. */
export async function checkRecipe(
  file: string,
  {
    signal,
    staticOnly,
    openRuntime,
    releaseRuntime,
    onProgress,
  }: {
    signal: AbortSignal;
    staticOnly: boolean;
    openRuntime(): Promise<Runtime>;
    releaseRuntime(): Promise<void>;
    onProgress?: DoctorProgressObserver;
  },
): Promise<DoctorReport> {
  const reportProgress = doctorProgressReporter(onProgress);
  let runtime: Runtime;
  try {
    runtime = await openRuntime();
  } catch (error) {
    signal.throwIfAborted();
    const report = doctorFailure('runtime.registration', error);
    reportProgress?.({ kind: 'finished', report });
    return report;
  }

  const report = await doctorRecipe(runtime, file, {
    signal,
    staticOnly,
    onProgress,
  }).catch((error: unknown) => {
    signal.throwIfAborted();
    return doctorFailure('doctor.runtime', error);
  });
  try {
    await releaseRuntime();
  } catch (error) {
    if (signal.aborted)
      throw new RuntimeCleanupInterruptedError(signal.reason, error);
    const cleanup = doctorFailure('runtime.cleanup', error);
    report.checks.push(...cleanup.checks);
    report.summary.failed += cleanup.summary.failed;
  }
  signal.throwIfAborted();
  reportProgress?.({ kind: 'finished', report });
  return report;
}
