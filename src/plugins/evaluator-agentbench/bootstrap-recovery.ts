import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentbenchInput,
  JsonObject,
  RuntimeContext,
} from '../../contracts/index.js';
import { isCandidateValidationFailure } from '../../shared/errors.js';
import { digest } from '../../shared/json.js';
import { plain } from '../shared/evaluator-adapter/data.js';
import { releasedApplicationInstances } from './finalized-timeout.js';

/** A sibling rejection can cancel SDK bootstrap before a native run exists.
 * Require the SDK boundary, empty native result, absent output and released
 * Application ownership together; unknown or started work remains non-retryable. */
export async function canRestartBootstrap(
  input: AgentbenchInput,
  receipt: JsonObject,
  context: RuntimeContext,
): Promise<boolean> {
  if (
    context.signal.aborted ||
    !['failed', 'cancelled'].includes(String(receipt.status)) ||
    receipt.callId !== context.callId ||
    receipt.experimentId !== context.experimentId ||
    typeof receipt.measurementRef !== 'string'
  )
    return false;
  const m = await context.readMeasurement(receipt.measurementRef);
  if (
    m.ref !== receipt.measurementRef ||
    m.callId !== context.callId ||
    m.experimentId !== context.experimentId ||
    m.candidateRef !== input.candidateRef ||
    plain(m.evaluator).pluginId !== 'evaluator.agentbench' ||
    m.status !== receipt.status ||
    m.coverage !== 'unknown' ||
    typeof m.diagnosticsRef !== 'string'
  )
    return false;
  const diagnostic = plain(await context.artifacts.readJson(m.diagnosticsRef));
  if (
    diagnostic.name !== 'EvaluatorRunError' ||
    diagnostic.phase !== 'bootstrap' ||
    !isCandidateValidationFailure(diagnostic.message)
  )
    return false;
  const provenanceRef = plain(m.provenance).artifactRef;
  if (typeof provenanceRef !== 'string') return false;
  const provenance = plain(await context.artifacts.readJson(provenanceRef));
  const native = plain(provenance.nativeResult);
  const config = plain(provenance.configuration);
  if (
    provenance.runIdentity !== null ||
    provenance.usageKnown !== false ||
    native.runId !== null ||
    native.jobId !== null ||
    native.kind !== null ||
    native.exitCode !== null ||
    typeof native.resultRef !== 'string' ||
    plain(config.scheduler).name !== 'local' ||
    digest(plain(config.run).taskIds) !== digest(input.taskIds) ||
    plain(config.output).directory !== join(context.directory, 'sdk')
  )
    return false;
  const saved = plain(await context.artifacts.readJson(native.resultRef));
  if (
    saved.snapshot !== null ||
    saved.metrics !== null ||
    Object.keys(plain(saved.result)).length
  )
    return false;
  try {
    await lstat(join(context.directory, 'sdk'));
    return false;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  return releasedApplicationInstances(input, receipt, context);
}
