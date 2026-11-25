import type { Logger } from '@logtape/logtape';

/** Update a running call's terminal status without producing a log line. */
export function reportTaskProgress(
  logger: Logger,
  id: string,
  detail: string,
): void {
  logger.debug('{detail}', {
    detail,
    activeTask: { id, detail },
    progressOnly: true,
  });
}

/** Record a stage transition and present it on the running call. */
export function reportTaskPhase(
  logger: Logger,
  { callId }: { callId?: string },
  detail: string,
): void {
  if (!callId) return;
  logger.debug('{detail}', { callId, detail });
  reportTaskProgress(logger, callId, detail);
}
