import type { ArtifactStore, JsonObject } from '../../contracts/index.js';
import { definition } from '../shared/evaluator-adapter/metric.js';
export async function successRate(
  artifacts: ArtifactStore,
  summary: JsonObject | null,
  sourceRef: string | null,
): Promise<JsonObject> {
  const definitionRef = await definition(
    artifacts,
    'successRate',
    'ratio',
    'scalar',
    'success-rate.rate',
    'native selected/denominator rules; no independent reweighting',
  );
  const rate = summary?.rate;
  if (
    typeof rate === 'number' &&
    Number.isFinite(rate) &&
    rate >= 0 &&
    rate <= 1 &&
    sourceRef
  )
    return {
      definitionRef,
      status: 'available',
      value: { kind: 'scalar', value: rate },
      source: { artifactRef: sourceRef, pointer: '/metrics/success-rate/rate' },
    };
  return {
    definitionRef,
    status: 'unavailable',
    value: null,
    reason: 'Native success-rate was not available',
    source: null,
  };
}
/** Preserve the SDK's partial-credit mean and denominator, including failed tasks. */
export async function meanReward(
  artifacts: ArtifactStore,
  summary: JsonObject | null,
  sourceRef: string | null,
): Promise<JsonObject> {
  const definitionRef = await definition(
    artifacts,
    'meanReward',
    'score',
    'scalar',
    'harbor-score.meanReward',
    'native selected/denominator rules; no independent reweighting',
  );
  const reward = summary?.meanReward;
  if (typeof reward === 'number' && Number.isFinite(reward) && sourceRef)
    return {
      definitionRef,
      status: 'available',
      value: { kind: 'scalar', value: reward },
      source: {
        artifactRef: sourceRef,
        pointer: '/metrics/harbor-score/meanReward',
      },
    };
  return {
    definitionRef,
    status: 'unavailable',
    value: null,
    reason: 'Native harbor-score meanReward was not available',
    source: null,
  };
}
