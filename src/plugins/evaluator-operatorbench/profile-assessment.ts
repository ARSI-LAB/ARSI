import type { JsonObject, RuntimeContext } from '../../contracts/index.js';
import { digest, object, string } from '../../shared/json.js';

export async function readProfileAssessment(
  ref: string,
  candidateRef: string,
  identity: {
    taskDigest: string;
    sdkBuildDigest: string;
    adapterDigest: string;
    caseId: string;
    seed: number;
  },
  context: RuntimeContext,
): Promise<{
  conditions: JsonObject;
  sourceDigest: string;
  comparisonKey: string;
}> {
  const measurement = await context.readMeasurement(ref);
  if (
    measurement.experimentId !== context.experimentId ||
    measurement.candidateRef !== candidateRef ||
    measurement.status !== 'succeeded' ||
    measurement.coverage !== 'complete' ||
    object(object(object(measurement.metrics).candidateValid).value).value !== 1
  )
    throw new Error(
      'Diagnostic assessment must be valid and belong to this candidate and experiment',
    );
  const conditions = object(
    await context.artifacts.readJson(
      string(object(measurement.conditions).artifactRef),
    ),
  );
  const provenance = object(
    await context.artifacts.readJson(
      string(object(measurement.provenance).artifactRef),
    ),
  );
  if (
    conditions.taskDigest !== identity.taskDigest ||
    conditions.sdkBuildDigest !== identity.sdkBuildDigest ||
    conditions.adapterDigest !== identity.adapterDigest ||
    provenance.cleanup !== 'confirmed'
  )
    throw new Error(
      'Diagnostic assessment task, build or cleanup identity mismatch',
    );
  const evaluation = object(conditions.evaluation);
  if (
    object(evaluation.contract).caseId !== identity.caseId ||
    digest(object(evaluation.protocol).seeds) !== digest([identity.seed])
  )
    throw new Error('Diagnostic assessment case or seed mismatch');
  if (evaluation.operation === 'profile')
    throw new Error('Diagnostic cannot certify another diagnostic');
  return {
    conditions: evaluation,
    sourceDigest: string(provenance.sourceDigest),
    comparisonKey: string(measurement.comparisonKey),
  };
}
