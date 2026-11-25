import type {
  FactStore,
  JsonObject,
  JsonValue,
} from '../../contracts/index.js';
import { memoryContract } from '../../contracts/plugin-types/memory.js';
import { digest, object, string } from '../../shared/json.js';
import type { Policy } from '../policy/policy.js';

export function agentReplayKey(
  binding: string,
  parentCallId: string,
  path: string,
  input: JsonObject,
  projectArtifactRef: string,
): string {
  return (
    'agent/' +
    digest({
      binding,
      parentCallId,
      path,
      input: { ...input, cwd: projectArtifactRef },
    })
  );
}

function stepShape(value: JsonValue, requirements: JsonObject): JsonValue {
  if (!Array.isArray(value)) throw new Error('Invalid locked Policy steps');
  return value.map((raw) => {
    const step = object(raw);
    const shape: JsonObject = { id: step.id!, type: step.type! };
    if (step.type === 'invoke')
      shape.contract = object(requirements[string(step.use)]).contract!;
    if (step.type === 'if') {
      shape.then = stepShape(object(step.then).steps!, requirements);
      shape.else = stepShape(object(step.else).steps!, requirements);
    }
    if (step.type === 'loop' || step.type === 'foreach')
      shape.steps = stepShape(step.steps!, requirements);
    return shape;
  });
}

export function assertRetryShape(locked: JsonObject, policy: Policy): void {
  const shape = (declaration: JsonObject): JsonObject => {
    const requirements = object(declaration.require);
    return {
      requirements,
      steps: stepShape(declaration.steps!, requirements),
    };
  };
  if (digest(shape(object(locked.policy))) !== digest(shape(policy.toJSON())))
    throw new Error(
      'Retry requires the same Policy shape (steps and plugin contracts)',
    );
}

/** Index Policy invocations that may have committed before their checkpoint. */
export async function readRetryCalls(
  facts: FactStore,
  id: string,
): Promise<ReadonlyMap<string, JsonObject>> {
  const steps = new Map<string, JsonObject>();
  const calls = facts.scan ? facts.scan('calls') : await facts.list('calls');
  for await (const call of calls) {
    if (call.experimentId !== id) continue;
    if (typeof call.agentProjectArtifactRef === 'string') {
      const key = agentReplayKey(
        string(call.bindingId),
        string(call.parentCallId),
        string(call.path),
        object(call.input),
        call.agentProjectArtifactRef,
      );
      const previous = steps.get(key);
      if (previous?.status !== 'succeeded') steps.set(key, call);
    }
    if (
      call.parentCallId !== 'root' ||
      typeof call.path !== 'string' ||
      !(
        call.path.startsWith('steps/') ||
        call.path.startsWith('evolution/') ||
        call.path === 'initialize'
      )
    )
      continue;
    if (steps.has(call.path))
      throw new Error(`Multiple call receipts for Policy path ${call.path}`);
    steps.set(call.path, call);
  }
  return steps;
}

export function checkpointedCalls(
  calls: ReadonlyMap<string, JsonObject> | undefined,
  restore: JsonObject | undefined,
  hasInitialCandidate: boolean,
): JsonObject[] {
  const journal = restore ? object(restore.journal) : {};
  return [...(calls?.entries() ?? [])]
    .filter(([path, call]) => {
      const entry = journal[path];
      if (path === 'initialize')
        return hasInitialCandidate && call.status === 'succeeded';
      if (!entry || object(object(entry).result).kind !== 'completed')
        return false;
      const { output, status, contractId } = call;
      return (
        status === 'succeeded' ||
        (status === 'failed' &&
          contractId === memoryContract.id &&
          output !== null &&
          typeof output === 'object' &&
          !Array.isArray(output) &&
          output.status === 'failed')
      );
    })
    .map(([, call]) => call);
}
