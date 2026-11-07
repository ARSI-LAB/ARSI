import type { JsonObject, RuntimeContext } from '../../contracts/index.js';
import { digest, object, string } from '../../shared/json.js';
import type { SdkOperatorResult } from './result.js';

type ProfileAssessment = {
  ref: string;
  conditions: JsonObject;
  sourceDigest: string;
  comparisonKey: string;
};

export function fixedConditions(run: JsonObject): JsonObject {
  const files = object(run.source).files;
  if (!Array.isArray(files)) throw new Error('Missing SDK source files');
  return {
    sdkIdentity: run.identity ?? null,
    pluginVersions: run.pluginVersions ?? null,
    fixedFiles: files
      .map((value) => {
        const file = object(value);
        return { path: string(file.path), sha256: string(file.sha256) };
      })
      .filter((file) => !['manifest.json', 'data/input.py'].includes(file.path))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

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
): Promise<ProfileAssessment> {
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
    ref,
    conditions: evaluation,
    sourceDigest: string(provenance.sourceDigest),
    comparisonKey: string(measurement.comparisonKey),
  };
}

export function profileConditions(
  result: SdkOperatorResult,
  assessment: ProfileAssessment,
): JsonObject {
  if (
    digest(result.conditions?.pluginVersions) !==
      digest(assessment.conditions.pluginVersions) ||
    digest(result.conditions?.sdkIdentity) !==
      digest(assessment.conditions.sdkIdentity)
  )
    throw new Error('Diagnostic SDK identity differs from its assessment');
  const assessedEnvironment = object(assessment.conditions.environment);
  const replay = object(object(result.profile?.metadata ?? {}).replay ?? {});
  if (
    result.profile?.status === 'completed' &&
    digest(replay.environment) !== digest(assessedEnvironment)
  )
    throw new Error('Diagnostic environment differs from its assessment');
  return {
    ...result.conditions,
    operation: 'profile',
    assessmentMeasurementRef: assessment.ref,
    assessmentComparisonKey: assessment.comparisonKey,
    environment: assessedEnvironment,
  };
}
