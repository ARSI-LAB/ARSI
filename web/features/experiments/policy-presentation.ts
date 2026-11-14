import type {
  CallSummary,
  CandidateSummary,
  JsonPreview,
  MeasurementSummary,
  MetricRecord,
} from '../../api/observation-client.js';
import type { HarnessStage } from './round-label-model.js';

const policies = new Set([
  'policy.harness2',
  'policy.harness2-reflection',
  'policy.swebench-harness2-reflection',
]);
export interface ComparisonPolicy {
  taskIds: string[];
}
export function comparisonPolicy(
  configuration: JsonPreview | null | undefined,
): ComparisonPolicy | null {
  if (!configuration || configuration.truncated) return null;
  try {
    const value: unknown = JSON.parse(configuration.text);
    if (!value || typeof value !== 'object' || !('policy' in value))
      return null;
    const policy = value.policy;
    if (!policy || typeof policy !== 'object') return null;
    // Current Recipe snapshots use id; ref remains readable in saved historical observations.
    const id = 'id' in policy ? policy.id : 'ref' in policy ? policy.ref : null;
    if (typeof id !== 'string' || !policies.has(id) || !('config' in policy))
      return null;
    const config = policy.config;
    if (!config || typeof config !== 'object' || !('dataset' in config))
      return null;
    const dataset = config.dataset;
    if (!dataset || typeof dataset !== 'object' || !('taskIds' in dataset))
      return null;
    const ids = dataset.taskIds;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      !ids.every(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ) ||
      new Set(ids).size !== ids.length
    )
      return null;
    return { taskIds: ids };
  } catch {
    return null;
  }
}

/** Paths are opaque execution-scope keys; step and branch names carry no UI semantics. */
function scope(call: CallSummary): string | null {
  const end = call.path?.lastIndexOf('/') ?? -1;
  return end > 0
    ? JSON.stringify([call.parentCallId, call.path!.slice(0, end)])
    : null;
}
const roles: Record<string, HarnessStage['variant']> = {
  invariantProposer: 'Invariant',
  domainProposer: 'Domain',
  composer: 'Composed',
};
export function comparisonStages(
  policy: ComparisonPolicy | null,
  candidates: CandidateSummary[],
  calls: CallSummary[],
  measurements: MeasurementSummary[],
  records: MetricRecord[],
): {
  evaluations: Map<string, HarnessStage>;
  candidates: Map<string, HarnessStage>;
} | null {
  if (!policy || !measurements.length) return null;
  const byId = new Map(calls.map((call) => [call.callId, call]));
  const proposals = new Map<string, CallSummary[]>();
  for (const call of calls) {
    const key = scope(call);
    if (key && call.pluginId.startsWith('proposer.'))
      proposals.set(key, [...(proposals.get(key) ?? []), call]);
  }
  const tasks = new Map<string, Set<string>>();
  for (const record of records)
    if (record.item?.subjectKind === 'task') {
      const values = tasks.get(record.ref) ?? new Set<string>();
      values.add(record.item.subjectId);
      tasks.set(record.ref, values);
    }
  const evaluations = new Map<string, HarnessStage>();
  const byScope = new Map<string, HarnessStage>();
  for (const measurement of measurements) {
    let call = byId.get(measurement.callId);
    const seen = new Set<string>();
    while (call && call.bindingId !== 'evaluator' && !seen.has(call.callId)) {
      seen.add(call.callId);
      call = byId.get(call.parentCallId ?? '');
    }
    if (
      !call ||
      call.bindingId !== 'evaluator' ||
      !call.pluginId.startsWith('evaluator.')
    )
      return null;
    const key = scope(call),
      subjects = [...(tasks.get(measurement.ref) ?? [])];
    if (!key || subjects.length !== 1) return null;
    const index = policy.taskIds.indexOf(subjects[0]!);
    if (index < 0) return null;
    const sources = proposals.get(key) ?? [];
    if (
      sources.length > 1 ||
      (sources.length === 1 && !roles[sources[0]!.bindingId])
    )
      return null;
    const variant = sources.length ? roles[sources[0]!.bindingId]! : 'Base';
    if (
      variant === 'Base' &&
      !candidates.some(
        (c) => c.ref === measurement.candidateRef && c.parentRef === null,
      )
    )
      return null;
    const stage = { round: `Round ${index + 1}`, variant };
    const previous = byScope.get(key);
    if (
      previous &&
      (previous.round !== stage.round || previous.variant !== stage.variant)
    )
      return null;
    byScope.set(key, stage);
    evaluations.set(measurement.ref, stage);
  }
  const mappedCandidates = new Map<string, HarnessStage>();
  for (const candidate of candidates) {
    if (candidate.parentRef === null) continue;
    const origins = calls.filter(
      (call) =>
        call.path === candidate.originPath &&
        roles[call.bindingId] &&
        call.pluginId.startsWith('proposer.'),
    );
    if (origins.length !== 1) return null;
    const key = scope(origins[0]!);
    const stage = key ? byScope.get(key) : undefined;
    if (!stage || stage.variant !== roles[origins[0]!.bindingId]) return null;
    mappedCandidates.set(candidate.ref, stage);
  }
  return { evaluations, candidates: mappedCandidates };
}
