import { getLogger } from '@logtape/logtape';
import type {
  AgentObservation,
  RuntimeContext,
} from '../../../contracts/index.js';
import { reportTaskProgress } from '../../../shared/task-progress.js';

const logger = getLogger(['arsi', 'runtime', 'manager']);

export function agentProgress({
  experimentId,
  bindingId,
  callId,
}: RuntimeContext): ((observation: AgentObservation) => void) | undefined {
  if (!logger.isEnabledFor('debug')) return;
  let mainRun: string | undefined;
  let turn = 1;
  let finalizing = false;
  const messages = new Set<string>();
  const seenTools = new Set<string>();
  const tools = new Map<string, string>();
  const subagents = new Set<string>();
  let previous: string | undefined;
  const update = (): void => {
    const tool = [...tools.values()].at(-1);
    const activity = subagents.size ? 'subagent' : (tool ?? 'thinking');
    const detail = finalizing ? 'finalizing' : `turn ${turn} · ${activity}`;
    if (detail === previous) return;
    previous = detail;
    reportTaskProgress(logger, callId, detail);
  };
  const checkpoint = (activity: string): void => {
    logger.debug('{bindingId} turn {turn} {activity}', {
      experimentId,
      bindingId,
      callId,
      turn,
      activity,
    });
  };
  update();

  return ({ runId, event }) => {
    if (
      finalizing ||
      (event.type === 'run.started' && event.parentRunId !== null)
    )
      return;
    mainRun ??= runId;
    if (runId !== mainRun) {
      if (event.type === 'run.finished' && subagents.delete(runId)) update();
      return;
    }

    switch (event.type) {
      case 'message.completed':
        if (event.role !== 'assistant') return;
        if (event.phase === 'final_answer') finalizing = true;
        else {
          if (messages.has(event.messageId)) return;
          messages.add(event.messageId);
          turn++;
          checkpoint('thinking');
        }
        break;
      case 'tool.started': {
        if (seenTools.has(event.toolCallId)) return;
        seenTools.add(event.toolCallId);
        const name = /^[\w.:-]{1,80}$/.test(event.name)
          ? event.name
          : undefined;
        const activity = name ? `tool ${name}` : 'tool';
        tools.set(event.toolCallId, activity);
        checkpoint(activity);
        break;
      }
      case 'tool.completed':
        tools.delete(event.toolCallId);
        subagents.delete(event.toolCallId);
        break;
      case 'subagent.activity':
        if (event.activity === 'started') subagents.add(event.childRunId);
        else if (event.activity !== 'interacted')
          subagents.delete(event.childRunId);
        break;
      default:
        return;
    }
    update();
  };
}
