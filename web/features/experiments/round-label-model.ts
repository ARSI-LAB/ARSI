import {
  comparisonStages,
  type ComparisonPolicy,
} from './policy-presentation.js';
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
export function buildRoundLabels(
  candidates: CandidateSummary[],
  calls: CallSummary[],
  measurements: MeasurementSummary[],
  records: MetricRecord[] = [],
  policy: ComparisonPolicy | null = null,
): {
  candidate(ref: string): string;
  evaluation(ref: string): string;
  harness(ref: string): HarnessStage | null;
  task(ref: string): string | null;
  evaluationGroup(refs: string[]): string | null;
  isHarness: boolean;
  candidateStage(ref: string): HarnessStage | null;
} {
  const comparison = comparisonStages(
    policy,
    candidates,
    calls,
    measurements,
    records,
  );
  const names = new Map<string, string>();
  const groups = new Map<string, CandidateSummary[]>();
  for (const candidate of candidates) {
    const origin = comparison?.candidates.get(candidate.ref);
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
      const phase = comparison?.evaluations.get(measurement.ref);
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
    isHarness: comparison !== null,
    candidateStage: (ref) => comparison?.candidates.get(ref) ?? null,
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
