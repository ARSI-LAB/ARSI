import type {
  ArtifactStore,
  JsonObject,
  JsonValue,
} from '../../../contracts/index.js';
import type { Measurement } from '../../../contracts/models/measurement.js';
import { digest, object } from '../../../shared/json.js';
import { validate } from '../../../shared/schema.js';
import { conditionsSchema } from './schemas/index.js';

export function comparisonBaseImage(environment: JsonObject): JsonValue {
  const image = environment.baseImage ?? null;
  if (
    environment.kind !== 'docker' ||
    image === null ||
    typeof image !== 'object' ||
    Array.isArray(image) ||
    typeof image.id !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(image.id)
  )
    return image;
  const { reference: _reference, ...identity } = image;
  return identity;
}

const schemaDigest = digest(conditionsSchema);

export async function agentbenchImageAliasesMatch(
  artifacts: ArtifactStore,
  before: Measurement,
  after: Measurement,
): Promise<boolean> {
  if (
    [before, after].some(
      ({ evaluator, conditions }) =>
        evaluator.pluginId !== 'evaluator.agentbench' ||
        conditions.schemaId !== 'measurement.conditions/v1' ||
        conditions.schemaDigest !== schemaDigest,
    )
  )
    return false;

  async function normalizedKey(
    measurement: Measurement,
  ): Promise<string | null> {
    const conditions = object(
      await artifacts.readJson(measurement.conditions.artifactRef),
    );
    validate(conditionsSchema, conditions, 'AgentBench measurement conditions');
    const fixed = object(conditions.fixed);
    if (
      conditions.kind !== 'agentbench' ||
      conditions.known !== true ||
      !fixed.source ||
      !fixed.identity ||
      !fixed.solver ||
      !Array.isArray(fixed.environments) ||
      digest(fixed) !== measurement.comparisonKey
    )
      return null;
    const environments = fixed.environments.map((record) =>
      Object.fromEntries(
        Object.entries(object(record)).map(([phase, value]) => {
          if (value === null) return [phase, null];
          const environment = object(value);
          return [
            phase,
            { ...environment, baseImage: comparisonBaseImage(environment) },
          ];
        }),
      ),
    );
    return digest({ ...fixed, environments });
  }

  const [a, b] = await Promise.all([
    normalizedKey(before),
    normalizedKey(after),
  ]);
  return a !== null && a === b;
}
