import type {
  AgentbenchInput,
  JsonObject,
  RuntimeContext,
} from '../../contracts/index.js';
import { plain } from '../shared/evaluator-adapter/data.js';
import { validateSnapshot } from '../shared/evaluator-adapter/measurement.js';
import { releasedApplicationInstances } from './finalized-timeout.js';

/** Explicit resume may repeat preparation only when the closed native run proves
 * no task attempt started and all RSI instances have been released. */
export async function canRestartPreparation(
  input: AgentbenchInput,
  receipt: JsonObject,
  context: RuntimeContext,
): Promise<boolean> {
  if (
    context.signal.aborted ||
    receipt.status !== 'failed' ||
    receipt.callId !== context.callId ||
    receipt.experimentId !== context.experimentId ||
    typeof receipt.measurementRef !== 'string'
  )
    return false;
  const measurement = await context.readMeasurement(receipt.measurementRef);
  if (
    measurement.ref !== receipt.measurementRef ||
    measurement.callId !== context.callId ||
    measurement.experimentId !== context.experimentId ||
    measurement.candidateRef !== input.candidateRef ||
    plain(measurement.evaluator).pluginId !== 'evaluator.agentbench' ||
    measurement.status !== 'failed' ||
    measurement.coverage !== 'none' ||
    typeof measurement.diagnosticsRef !== 'string'
  )
    return false;
  const diagnostic = plain(
    await context.artifacts.readJson(measurement.diagnosticsRef),
  );
  if (
    diagnostic.phase !== 'enumerate' ||
    diagnostic.name !== 'EvaluatorRunError'
  )
    return false;
  const provenanceRef = plain(measurement.provenance).artifactRef;
  if (typeof provenanceRef !== 'string') return false;
  const provenance = plain(await context.artifacts.readJson(provenanceRef));
  const resultRef = plain(provenance.nativeResult).resultRef;
  if (typeof resultRef !== 'string') return false;
  const saved = plain(await context.artifacts.readJson(resultRef));
  const result = plain(saved.result);
  const snapshot = plain(saved.snapshot);
  const run = plain(snapshot.run);
  const failure = plain(run.failure);
  if (
    typeof result.exitCode !== 'number' ||
    result.exitCode === 0 ||
    run.status !== 'error' ||
    typeof run.finishedAt !== 'string' ||
    !run.finishedAt ||
    failure.code !== 'ENV_PREPARATION_FAILED' ||
    failure.phase !== 'prepare' ||
    failure.category !== 'infrastructure' ||
    failure.action !== 'finalize'
  )
    return false;
  try {
    validateSnapshot(snapshot);
  } catch {
    return false;
  }
  const selected = run.taskIds;
  const pending = snapshot.pendingTaskIds;
  if (
    !input.taskIds.length ||
    !Array.isArray(selected) ||
    selected.length !== input.taskIds.length ||
    !input.taskIds.every((id) => selected.includes(id)) ||
    !Array.isArray(pending) ||
    pending.length !== input.taskIds.length ||
    !input.taskIds.every((id) => pending.includes(id)) ||
    !Array.isArray(snapshot.records) ||
    snapshot.records.length
  )
    return false;
  return releasedApplicationInstances(input, receipt, context);
}
