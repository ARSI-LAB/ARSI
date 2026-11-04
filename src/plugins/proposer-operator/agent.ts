import type {
  AgentInput,
  JsonObject,
  RuntimeContext,
} from '../../contracts/index.js';
import { digest, object } from '../../shared/json.js';
import { validate } from '../../shared/schema.js';

export type OperatorAgentStage =
  | 'diagnose'
  | 'diagnose-metrics'
  | 'generate'
  | 'repair'
  | 'summarize';

export const defaultModelRequestTimeoutMs = 120000;

export class OperatorModelOutputError extends Error {}

/** A request and all delegated sessions share Manager-owned accounting. */
export async function requestOperatorAgent(
  stage: OperatorAgentStage,
  request: AgentInput,
  context: RuntimeContext,
  timeoutMs = defaultModelRequestTimeoutMs,
): Promise<JsonObject> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error(
      'Operator modelRequestTimeoutMs must be a positive integer',
    );
  context = context.extend({
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]),
  });
  context.signal.throwIfAborted();
  if (context.scope)
    throw new Error(
      'Operator Agent requests cannot replace an outer budget scope',
    );
  const scope = {
    id: 'operator-' + digest({ callId: context.callId, stage }),
    signal: context.signal,
    limits: {
      modelCalls: 2,
      elapsedWallMs: timeoutMs,
      evidenceBytes: 2 * 1024 * 1024,
    },
  };
  if (Buffer.byteLength(JSON.stringify(request)) > 2 * 1024 * 1024)
    throw new Error(
      'Operator request exceeds 2 MiB; hardware context cannot be truncated',
    );
  let result: JsonObject;
  try {
    result = await context
      .extend({ scope, signal: context.signal })
      .invokeAgent({
        ...request,
        prompt:
          request.prompt +
          '\n\nThe authorized snapshots are already in input.sourceFiles; use them directly without reading the same files again. This stage has two total model calls, including tool continuations and all delegates. Complete the JSON response directly; do not delegate this bounded stage.',
        input: {
          ...object(request.input ?? {}),
          sourceFiles: request.files ?? {},
        },
        allowTools: false,
        maxModelCalls: 2,
      });
  } catch (error) {
    context.signal.throwIfAborted();
    if (
      error instanceof Error &&
      error.message.startsWith(
        'Agent model-call limit reached; last output validation failed:',
      )
    )
      throw new OperatorModelOutputError(error.message, { cause: error });
    throw error;
  }
  context.signal.throwIfAborted();
  try {
    validate(request.outputSchema, result, `Operator ${stage} response`);
  } catch (error) {
    throw new OperatorModelOutputError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  return object(result);
}
