import { fileURLToPath } from 'node:url';
import {
  type JsonObject,
  type RuntimeContext,
} from '../../../contracts/index.js';
import { digest, object } from '../../../shared/json.js';
import { AgentOutputError } from '../../../contracts/runtime/errors.js';
import { prepareAgentProject } from '../agent-editing/project.js';
import {
  renderTaskMessage,
  type MessageStage,
  type MessageTemplates,
  type MessageVariables,
} from '../agent-editing/task-message.js';
import {
  type OperatorAgentStage,
  defaultModelRequestTimeoutMs,
} from './schema.js';

export class OperatorModelOutputError extends Error {}

const operatorReviewer = {
  name: 'operator-reviewer',
  description:
    'Review operator source and supplied evidence for a focused question.',
  prompt: fileURLToPath(new URL('./operator-reviewer.md', import.meta.url)),
};

export const sourceSnapshot = 'context/sources/';
export const operatorTaskDir = 'context/task/';
const operatorInputPath = 'context/input.json';

export type OperatorStageInput = {
  sourcePath: string;
  sourceFiles: string[];
  editablePaths: string[];
  goal: string;
  taskMessage: {
    templates?: MessageTemplates<string>;
    fallback: string;
    variables?: MessageVariables;
    stage: MessageStage;
  };
  prompt: string;
  files: Record<string, string>;
  input: JsonObject;
  outputSchema: JsonObject;
};

/** A request and all delegated sessions share Manager-owned accounting. */
export async function requestOperatorAgent(
  stage: OperatorAgentStage,
  agentRef: string,
  request: OperatorStageInput,
  context: RuntimeContext,
  timeoutMs = defaultModelRequestTimeoutMs,
): Promise<JsonObject> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > 2147483647
  )
    throw new Error(
      'Operator modelRequestTimeoutMs must be an integer from 0 to 2147483647; 0 disables the stage deadline',
    );
  if (timeoutMs > 0)
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
    limits: timeoutMs > 0 ? { elapsedWallMs: timeoutMs } : {},
  };
  const message = await renderTaskMessage(
    context,
    request.taskMessage.templates,
    request.taskMessage.fallback,
    {
      goal: request.goal,
      inputPath: operatorInputPath,
      sourcePath: `${sourceSnapshot}${request.sourcePath}`,
      ...(stage === 'summarize' ? {} : { taskDir: operatorTaskDir }),
      ...request.taskMessage.variables,
    },
    request.taskMessage.stage,
  );
  let result: JsonObject;
  try {
    const instructions =
      stage === 'summarize'
        ? 'Read context/input.json for the confirmed facts and the read-only source snapshot. Return the requested summary as JSON.'
        : `Read ${operatorInputPath} for the stage data. Read the operator source tree in ${sourceSnapshot} and the task snapshots in ${operatorTaskDir}. Treat all snapshots as read-only. ${stage === 'generate' || stage === 'repair' ? 'Return proposed edits in the JSON response using only exact candidate-relative paths from editablePaths in context/input.json.' : 'Return the diagnosis matching outputSchema.'} The entry is ${JSON.stringify(request.sourcePath)}. Delegate when useful and return the complete JSON response.`;
    const cwd = await prepareAgentProject(
      context,
      request.prompt + '\n\n' + instructions,
      {
        ...request.files,
        [operatorInputPath]:
          JSON.stringify(
            {
              ...request.input,
              sourcePath: request.sourcePath,
              sourceFiles: request.sourceFiles,
              editablePaths: request.editablePaths,
            },
            null,
            2,
          ) + '\n',
      },
      [],
      [operatorReviewer],
    );
    context.signal.throwIfAborted();
    result = await context.extend({ scope }).invokeAgent(agentRef, {
      cwd,
      message,
      outputSchema: request.outputSchema,
    });
  } catch (error) {
    context.signal.throwIfAborted();
    if (error instanceof AgentOutputError)
      throw new OperatorModelOutputError(error.message, { cause: error });
    throw error;
  }
  context.signal.throwIfAborted();
  return object(result);
}
