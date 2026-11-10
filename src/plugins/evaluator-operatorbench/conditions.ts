import type { JsonObject, RuntimeContext } from '../../contracts/index.js';
import { compareFilePaths } from '../../shared/paths.js';
import { digest, object, string } from '../../shared/json.js';
import type { SdkOperatorResult } from './result.js';
import type { PreparedOperatorCase } from './kernel-input.js';

type ProfileAssessment = {
  ref: string;
  conditions: JsonObject;
  sourceBundleDigest: string;
  comparisonKey: string;
};

export function fixedConditions(
  run: JsonObject,
  prepared: Pick<PreparedOperatorCase, 'sourceInventory'>,
): JsonObject & { fixedFiles: { path: string; sha256: string }[] } {
  const files = object(run.source).files;
  if (!Array.isArray(files)) throw new Error('Missing SDK source files');
  const inventory = prepared.sourceInventory;
  const mutable = inventory.mutablePaths.map(
    (path) => `data/candidate/${path}`,
  );
  return {
    sdkIdentity: run.identity ?? null,
    pluginVersions: run.pluginVersions ?? null,
    fixedFiles: files
      .map((value) => {
        const file = object(value);
        return { path: string(file.path), sha256: string(file.sha256) };
      })
      .filter(
        (file) => file.path !== 'manifest.json' && !mutable.includes(file.path),
      )
      .sort(compareFilePaths),
    candidateLayout: {
      entryFile: inventory.entryFile,
      files: inventory.files.map((file) => file.path).sort(),
      mutablePaths: [...inventory.mutablePaths].sort(),
    },
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
    sourceBundleDigest: string(provenance.sourceBundleDigest),
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
