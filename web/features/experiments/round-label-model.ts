import type {
  CallSummary,
  CandidateSummary,
  MeasurementSummary,
  MetricRecord,
} from '../../api/observation-client.js';
import { evaluationOrdinals } from './record-identifiers.js';

export function roundLabel(path: string | null | undefined): string | null {
  const rounds = [...(path ?? '').matchAll(/(?:^|\/)loop\/(\d+)(?=\/|$)/g)].map(
    (match) => Number(match[1]) + 1,
  );
  return rounds.length
    ? rounds.map((round) => `Round ${round}`).join(' / ')
    : null;
}
export interface HarnessStage {
  round: string;
  variant: 'Base' | 'Invariant' | 'Domain' | 'Composed';
}
/** Recognize the recorded Harness2 branches, not arbitrary loop names. */
export function harnessStage(
  path: string | null | undefined,
): HarnessStage | null {
  const match =
    /(?:^|\/)loop\/(\d+)\/(base|invariant|domain|compose)\/[^/]+\/(execute_base|propose_inv|execute_inv|propose_dom|execute_dom|compose_candidate|execute_composed)(?:\/|$)/.exec(
      path ?? '',
    );
  if (!match) return null;
  const variants = {
    base: 'Base',
    invariant: 'Invariant',
    domain: 'Domain',
    compose: 'Composed',
  } as const;
  return {
    round: `Round ${Number(match[1]) + 1}`,
    variant: variants[match[2] as keyof typeof variants],
  };
}
export function buildRoundLabels(
  candidates: CandidateSummary[],
  calls: CallSummary[],
  measurements: MeasurementSummary[],
  records: MetricRecord[] = [],
): {
  candidate(ref: string): string;
  evaluation(ref: string): string;
  harness(ref: string): HarnessStage | null;
  task(ref: string): string | null;
  evaluationGroup(refs: string[]): string | null;
  isHarness: boolean;
} {
  const names = new Map<string, string>();
  const groups = new Map<string, CandidateSummary[]>();
  for (const candidate of candidates) {
    const origin = harnessStage(candidate.originPath);
    const name =
      candidate.parentRef === null
        ? 'Baseline'
        : origin
          ? `${origin.round} · ${origin.variant}`
          : roundLabel(candidate.originPath);
    if (name) groups.set(name, [...(groups.get(name) ?? []), candidate]);
  }
  for (const [name, group] of groups)
    for (const [index, candidate] of group
      .sort((a, b) => a.ref.localeCompare(b.ref))
      .entries())
      names.set(
        candidate.ref,
        `${name}${group.length > 1 ? ` · ${index + 1}` : ''}`,
      );
  const byId = new Map(calls.map((call) => [call.callId, call]));
  const ordinals = evaluationOrdinals(measurements);
  const evaluations = new Map<string, string>();
  const harness = new Map<string, HarnessStage>();
  for (const measurement of measurements) {
    let call = byId.get(measurement.callId);
    const seen = new Set<string>();
    while (call && !seen.has(call.callId)) {
      seen.add(call.callId);
      const path = call.path ?? '';
      const phase = harnessStage(path);
      if (phase) {
        harness.set(measurement.ref, phase);
        evaluations.set(measurement.ref, `${phase.round} · ${phase.variant}`);
        break;
      }
      const round = roundLabel(path);
      const stage = /(?:^|\/)train(?:\/|$)/.test(path)
        ? 'Training'
        : /(?:^|\/)validate(?:\/|$)/.test(path)
          ? 'Validation'
          : /(?:^|\/)(?:test|final_test)(?:\/|$)/.test(path)
            ? 'Final test'
            : null;
      const label = round
        ? `${round} · ${stage ?? 'Evaluation'}`
        : /(?:^|\/)baseline(?:\/|$)/.test(path)
          ? 'Baseline evaluation'
          : stage;
      if (label) {
        evaluations.set(measurement.ref, label);
        break;
      }
      call = call.parentCallId ? byId.get(call.parentCallId) : undefined;
    }
  }
  const duplicates = new Map<string, number>();
  for (const label of evaluations.values())
    duplicates.set(label, (duplicates.get(label) ?? 0) + 1);
  const tasks = new Map<string, Set<string>>();
  for (const record of records) {
    if (record.item?.subjectKind !== 'task') continue;
    const names = tasks.get(record.ref) ?? new Set<string>();
    names.add(record.item.subjectId);
    tasks.set(record.ref, names);
  }
  const task = (ref: string): string | null => {
    const names = [...(tasks.get(ref) ?? [])];
    return names.length === 1 ? names[0]! : null;
  };
  const repeated = new Map<string, string[]>();
  for (const measurement of [...measurements].sort(
    (a, b) =>
      (a.startedAt ?? '').localeCompare(b.startedAt ?? '') ||
      a.ref.localeCompare(b.ref),
  )) {
    const label = evaluations.get(measurement.ref);
    if (label && harness.has(measurement.ref))
      repeated.set(label, [...(repeated.get(label) ?? []), measurement.ref]);
  }
  return {
    isHarness:
      harness.size > 0 ||
      candidates.some(
        (candidate) => harnessStage(candidate.originPath) !== null,
      ),
    harness: (ref) => harness.get(ref) ?? null,
    task,
    evaluationGroup: (refs) => {
      if (!refs.length || refs.some((ref) => !harness.has(ref))) return null;
      const rounds = [...new Set(refs.map((ref) => harness.get(ref)!.round))];
      const taskNames = [
        ...new Set(
          refs.map(task).filter((name): name is string => name !== null),
        ),
      ];
      return (
        rounds.join(' / ') +
        (taskNames.length === 1
          ? ` · ${taskNames[0]!.replace(/^workbuddy\//, '')}`
          : '')
      );
    },
    candidate: (ref) =>
      names.get(ref) ??
      (candidates.some((c) => c.ref === ref)
        ? `Candidate ${[...candidates].sort((a, b) => a.ref.localeCompare(b.ref)).findIndex((c) => c.ref === ref) + 1}`
        : 'Candidate'),
    evaluation: (ref) => {
      const label = evaluations.get(ref);
      if (label && harness.has(ref)) {
        const refs = repeated.get(label) ?? [];
        return label + (refs.length > 1 ? ` · ${refs.indexOf(ref) + 1}` : '');
      }
      return label
        ? label +
            ((duplicates.get(label) ?? 0) > 1
              ? ` · Evaluation ${ordinals.get(ref)}`
              : '')
        : `Evaluation ${ordinals.get(ref) ?? ref}`;
    },
  };
}
