import type {
  AgentbenchInput,
  JsonObject,
  RuntimeContext,
} from '../../contracts/index.js';
import { plain } from '../shared/evaluator-adapter/data.js';
import { validateSnapshot } from '../shared/evaluator-adapter/measurement.js';
import { strings } from '../../shared/json.js';

/** A benchmark-defined, non-retryable verifier timeout is failed measurement data,
 * never a valid zero score. Unconfirmed effects and infrastructure failures stay fatal. */
export function isFinalizedVerifierTimeout(
  result: JsonObject,
  ids: string[],
): boolean {
  const snapshot = plain(result.snapshot);
  const run = plain(snapshot.run);
  if (
    typeof result.exitCode !== 'number' ||
    result.exitCode === 0 ||
    run.status !== 'error' ||
    typeof run.finishedAt !== 'string' ||
    !run.finishedAt ||
    !ids.length ||
    !Array.isArray(snapshot.records) ||
    snapshot.records.length !== ids.length ||
    !Array.isArray(snapshot.pendingTaskIds) ||
    snapshot.pendingTaskIds.length
  )
    return false;
  try {
    validateSnapshot(snapshot);
    const selected = strings(run.taskIds);
    if (
      selected.length !== ids.length ||
      !ids.every((id) => selected.includes(id))
    )
      return false;
  } catch {
    return false;
  }
  return snapshot.records.every((raw) => {
    const record = plain(raw);
    return (
      record.executionStatus === 'failed' &&
      record.scoreStatus === 'invalid' &&
      record.cleanupStatus === 'cleaned' &&
      Array.isArray(record.errors) &&
      record.errors.length > 0 &&
      record.errors.every((rawError) => {
        const error = plain(rawError);
        return (
          error.code === 'VERIFY_TIMEOUT' &&
          error.phase === 'verify' &&
          error.category === 'verifier' &&
          error.scope === 'attempt' &&
          error.retryable === false &&
          error.action === 'finalize'
        );
      })
    );
  });
}

/** Reuse a legacy failed receipt only after both native and Application cleanup
 * are confirmed. This reads immutable results; it never repeats verification. */
export async function reconciledVerifierTimeout(
  input: AgentbenchInput,
  receipt: JsonObject,
  context: RuntimeContext,
): Promise<string | null> {
  if (
    context.signal.aborted ||
    receipt.status !== 'failed' ||
    receipt.callId !== context.callId ||
    receipt.experimentId !== context.experimentId ||
    typeof receipt.measurementRef !== 'string' ||
    !receipt.measurementRef
  )
    return null;
  const measurement = await context.readMeasurement(receipt.measurementRef);
  if (
    measurement.ref !== receipt.measurementRef ||
    measurement.experimentId !== context.experimentId ||
    measurement.callId !== context.callId ||
    measurement.candidateRef !== input.candidateRef ||
    plain(measurement.evaluator).pluginId !== 'evaluator.agentbench' ||
    measurement.status !== 'failed' ||
    measurement.coverage !== 'complete' ||
    measurement.diagnosticsRef !== null
  )
    return null;
  const provenanceRef = plain(measurement.provenance).artifactRef;
  if (typeof provenanceRef !== 'string') return null;
  const provenance = plain(await context.artifacts.readJson(provenanceRef));
  const native = plain(provenance.nativeResult);
  if (typeof native.resultRef !== 'string') return null;
  const saved = plain(await context.artifacts.readJson(native.resultRef));
  if (
    !isFinalizedVerifierTimeout(
      { ...plain(saved.result), snapshot: saved.snapshot ?? null },
      input.taskIds,
    )
  )
    return null;
  if (!(await releasedApplicationInstances(input, receipt, context)))
    return null;
  return receipt.measurementRef;
}

export async function releasedApplicationInstances(
  input: AgentbenchInput,
  receipt: JsonObject,
  context: RuntimeContext,
): Promise<boolean> {
  const children = (await context.facts.list('calls')).filter(
    (call) => call.parentCallId === receipt.callId,
  );
  if (
    children.some(
      (call) =>
        call.status !== 'succeeded' ||
        call.experimentId !== context.experimentId,
    )
  )
    return false;
  const acquisitions = children.filter(
    (call) =>
      call.bindingId === '_application' &&
      plain(call.input).action === 'acquire',
  );
  if (!acquisitions.length) return false;
  for (const acquire of acquisitions) {
    const id = plain(acquire.output).instanceId;
    if (
      typeof id !== 'string' ||
      !children.some(
        (call) =>
          call.bindingId === '_application' &&
          plain(call.input).action === 'release' &&
          plain(call.input).instanceId === id &&
          plain(call.output).status === 'released',
      )
    )
      return false;
    const instance = await context.facts.read('instances', id);
    if (
      instance.status !== 'released' ||
      instance.experimentId !== context.experimentId ||
      instance.candidateRef !== input.candidateRef
    )
      return false;
  }
  return true;
}
