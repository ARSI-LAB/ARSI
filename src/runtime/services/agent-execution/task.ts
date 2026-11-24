import type {
  AgentObservation,
  CallProgressUpdate,
  EventPipeline,
  JsonObject,
  Operation,
} from '../../../contracts/index.js';
import { AgentOutputError } from '../../../contracts/runtime/errors.js';
import {
  agentContract,
  type AgentInput,
} from '../../../contracts/plugin-types/agent.js';
import { agentObservationSchema } from '../../../contracts/models/agent-record.js';
import {
  parseConfig,
  validate,
  validateSchemaDefinition,
} from '../../../shared/schema.js';
import { object } from '../../../shared/json.js';
import { FileAgentRecorder } from '../../storage/agent-records.js';

function observeAgentProgress(
  report: (update: CallProgressUpdate) => void,
): (observation: AgentObservation) => void {
  let model = '';
  const turns = new Set<string>();
  const tools = new Map<string, { runId: string; name: string }>();
  let toolCount = 0;
  let lastTool = '';
  return ({ event, runId, native }) => {
    let warning: string | undefined;
    switch (event.type) {
      case 'session.started':
        if (event.model) model = event.model;
        break;
      case 'message.completed':
        if (event.role !== 'assistant') return;
        turns.add(JSON.stringify([runId, native?.turnId ?? event.messageId]));
        break;
      case 'tool.started': {
        const key = JSON.stringify([runId, event.toolCallId]);
        if (!tools.has(key)) toolCount += 1;
        tools.set(key, { runId, name: event.name });
        break;
      }
      case 'tool.completed': {
        const key = JSON.stringify([runId, event.toolCallId]);
        const name = event.name || tools.get(key)?.name || 'tool';
        tools.delete(key);
        lastTool = `${name} (${event.status})`;
        if (event.status === 'failed') warning = `tool ${name} failed`;
        break;
      }
      case 'run.finished':
        for (const [key, tool] of tools)
          if (tool.runId === runId) tools.delete(key);
        break;
      default:
        return;
    }
    const detail = [
      model,
      turns.size ? `turn ${turns.size}` : '',
      toolCount ? `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const lines = [...tools.values()]
      .slice(-3)
      .map(({ name }) => `tool: ${name}`);
    if (tools.size > lines.length)
      lines.push(`+${tools.size - lines.length} more active tools`);
    if (lastTool) lines.push(`last: ${lastTool}`);
    report({
      detail,
      lines,
      ...(warning ? { notice: warning, level: 'warning' } : {}),
    });
  };
}

/** Installed by the registry for every Agent. Plugins need only execute/dispose. */
export function managedAgentOperation(operation: Operation): Operation {
  const active = new Map<AbortController, Promise<JsonObject>>();
  return {
    async execute(input, context) {
      const request = parseConfig<AgentInput>(
        agentContract.input_schema,
        input,
        'Agent input',
      );
      validateSchemaDefinition(request.outputSchema, 'Agent outputSchema');
      context.signal.throwIfAborted();
      const directory = request.cwd;
      const controller = new AbortController();
      const signal = AbortSignal.any([context.signal, controller.signal]);
      const execution = (async (): Promise<JsonObject> => {
        const progress = context.reportProgress
          ? observeAgentProgress(context.reportProgress.bind(context))
          : undefined;
        let recorder: FileAgentRecorder | undefined;
        let recordingFailed = false;
        try {
          recorder = new FileAgentRecorder(context.directory);
        } catch {
          recordingFailed = true;
        }
        const record = (observation: AgentObservation): void => {
          if (recordingFailed || !recorder) return;
          try {
            recorder.record(observation);
          } catch {
            // Optional observation must never cancel or change the Agent result.
            recordingFailed = true;
          }
        };
        // Native detail is optional call-local telemetry. The framework still records
        // details when available; the Manager receipt owns input, result and status.
        const emit = ((
          ...args: Parameters<EventPipeline['emit']>
        ): ReturnType<EventPipeline['emit']> => {
          const index = typeof args[0] === 'string' ? 0 : 1;
          if (args[index] === 'rsi/agent-observation') {
            let observation: AgentObservation;
            try {
              observation = parseConfig<AgentObservation>(
                agentObservationSchema,
                args[index + 1],
                'Agent observation',
              );
            } catch (error) {
              record({
                runId: 'main',
                event: {
                  type: 'observation.gap',
                  reason:
                    error instanceof Error ? error.message : String(error),
                },
              });
              return;
            }
            record(observation);
            try {
              progress?.(observation);
            } catch {
              // Progress is optional and separate from trace recording.
            }
            return;
          }
          return Reflect.apply(context.event.emit, context.event, args);
        }) as EventPipeline['emit'];
        const scope = context.extend({
          agentProject: directory,
          signal,
          event: { ...context.event, emit },
        });
        try {
          const output = await operation.execute(input, scope);
          signal.throwIfAborted();
          let result: JsonObject;
          try {
            validate(request.outputSchema, output, 'Agent output');
            result = object(output);
          } catch (error) {
            throw new AgentOutputError(
              error instanceof Error ? error.message : String(error),
              { cause: error },
            );
          }
          return result;
        } finally {
          try {
            await recorder?.close(!recordingFailed);
          } catch {
            // Closing optional telemetry cannot replace execution or cancellation.
          }
        }
      })();
      active.set(controller, execution);
      try {
        return await execution;
      } finally {
        active.delete(controller);
      }
    },
    async dispose() {
      for (const controller of active.keys())
        controller.abort(new Error('Agent disposed'));
      await Promise.allSettled(active.values());
      await operation.dispose();
    },
  };
}
