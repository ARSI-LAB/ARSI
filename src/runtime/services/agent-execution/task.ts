import type {
  AgentObservation,
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
import { agentProgress } from './progress.js';

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
        let reportProgress = agentProgress(context);
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
            if (!signal.aborted) {
              try {
                reportProgress?.(observation);
              } catch {
                // Presentation cannot change the Agent result.
                reportProgress = undefined;
              }
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
          reportProgress = undefined;
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
