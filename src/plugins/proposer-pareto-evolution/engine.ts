import type { JsonObject } from '../../contracts/index.js';
import type { PromptModule, ParetoEvolutionSettings } from './schema.js';

/**
 * Deterministic population bookkeeping. The Policy owns evaluation and proposal
 * calls; this module owns ancestry, Pareto selection, module merge rules and the
 * seeded stochastic sampler.
 */

export interface CandidateRecord extends JsonObject {
  ref: string;
  artifactRef: string;
  /** Workspace base used by the Application when this candidate was committed. */
  applicationParentRef: string | null;
  /** Genetic source candidates (mutation: one, crossover: both sources). */
  parents: string[];
  /** Transitive genetic ancestry, never including the candidate itself. */
  ancestors: string[];
  origin: 'base' | 'mutation' | 'crossover';
  createdRound: number;
  /** Per-selection-instance scores. Unknown or unavailable values stay null. */
  scores: Record<string, number | null>;
  /** Mean of observed selection scores, or null when no score is available. */
  aggregate: number | null;
  /** True only when every configured selection instance has an observed score. */
  aggregateComplete: boolean;
  moduleIds: string[];
}

export interface ParetoEvolutionState extends JsonObject {
  schemaVersion: 'rsi.proposer-pareto-evolution-state/v1';
  seed: number;
  rng: number;
  feedbackTaskIds: string[];
  selectionTaskIds: string[];
  selectionTruncated: boolean;
  baselineCandidateRef: string | null;
  /** Measurements already accounted for; replaying a result does not consume rollouts. */
  evaluationRefs: string[];
  selectionConditions: Record<string, string | null>;
  candidates: CandidateRecord[];
  moduleCursor: number;
  completedRounds: number;
  rolloutsUsed: number;
  mergeAttempts: string[];
  rounds: RoundReport[];
  bestCandidateRef: string | null;
  bestAggregateScore: number | null;
  done: boolean;
  stopReason: string | null;
  datasetDegenerate: boolean;
  weightsChanged: false;
}

export interface RoundReport extends JsonObject {
  round: number;
  strategy: 'mutation' | 'crossover';
  status: 'admitted' | 'rejected' | 'no-change' | 'evaluation-failed';
  parentRefs: string[];
  ancestorRef: string | null;
  moduleIds: string[];
  taskIds: string[];
  parentScores: (number | null)[];
  proposalScores: (number | null)[];
  candidateRef: string | null;
  selectionScores: Record<string, number | null>;
  rollouts: number;
  reason: string;
}

export interface MergeChoice {
  left: CandidateRecord;
  right: CandidateRecord;
  ancestor: CandidateRecord;
  key: string;
}

export interface EvaluationOutcome {
  comparisonKey: string | null;
  itemComparisonKeys: Record<string, string | null>;
  scoreDefinitionRefs: Record<string, string | null>;
  scores: Record<string, number | null>;
  rollouts: number;
}

function stateRng(state: ParetoEvolutionState): Rng {
  return new Rng(state.rng);
}

export class Rng {
  private value: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
      throw new Error(
        'Pareto evolution proposer seed must be an unsigned 32-bit integer',
      );
    this.value = seed >>> 0;
  }

  get state(): number {
    return this.value >>> 0;
  }

  next(): number {
    // mulberry32; the persisted state makes every stochastic choice replayable.
    this.value = (this.value + 0x6d2b79f5) >>> 0;
    let t = this.value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  integer(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0)
      throw new Error(
        'Pareto evolution proposer random range must be a positive integer',
      );
    return Math.floor(this.next() * maxExclusive);
  }
}

export function sampleWithoutReplacement<T>(
  rng: Rng,
  values: readonly T[],
  count: number,
): T[] {
  if (count < 0 || count > values.length)
    throw new Error(
      'Pareto evolution proposer sample size is outside the population',
    );
  const pool = [...values];
  for (let index = 0; index < count; index++) {
    const pick = index + rng.integer(pool.length - index);
    [pool[index], pool[pick]] = [pool[pick]!, pool[index]!];
  }
  return pool.slice(0, count);
}

export function sampleFeedbackTasks(
  rng: Rng,
  state: Pick<ParetoEvolutionState, 'feedbackTaskIds' | 'rounds'>,
  settings: Pick<ParetoEvolutionSettings, 'minibatchSize' | 'feedbackSampling'>,
): string[] {
  const count = Math.min(settings.minibatchSize, state.feedbackTaskIds.length);
  if (settings.feedbackSampling !== 'coverage-first')
    return sampleWithoutReplacement(rng, state.feedbackTaskIds, count);

  const covered = new Set<string>();
  for (const round of state.rounds) {
    for (const [index, task] of round.taskIds.entries()) {
      // Parent scores are flattened in parent order; any finite parent suffices.
      if (
        round.parentRefs.some((_, parent) =>
          Number.isFinite(
            round.parentScores[parent * round.taskIds.length + index],
          ),
        )
      )
        covered.add(task);
    }
  }
  const unseen = state.feedbackTaskIds.filter((task) => !covered.has(task));
  if (!unseen.length)
    return sampleWithoutReplacement(rng, state.feedbackTaskIds, count);
  const selected = sampleWithoutReplacement(
    rng,
    unseen,
    Math.min(count, unseen.length),
  );
  if (selected.length === count) return selected;
  return [
    ...selected,
    ...sampleWithoutReplacement(
      rng,
      state.feedbackTaskIds.filter((task) => covered.has(task)),
      count - selected.length,
    ),
  ];
}

export function mean(values: readonly number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function scoresFor(
  scores: Record<string, number | null>,
  tasks: readonly string[],
): (number | null)[] {
  return tasks.map((task) => {
    const value = scores[task];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  });
}

export function candidateAggregate(
  candidate: Pick<CandidateRecord, 'scores'>,
  tasks: readonly string[],
): { aggregate: number | null; complete: boolean; observed: number } {
  const values = scoresFor(candidate.scores, tasks);
  const observed = values.filter((value): value is number => value !== null);
  return {
    aggregate: mean(observed),
    complete: values.length > 0 && observed.length === values.length,
    observed: observed.length,
  };
}

export function refreshCandidate(
  candidate: CandidateRecord,
  tasks: readonly string[],
): CandidateRecord {
  const aggregate = candidateAggregate(candidate, tasks);
  return {
    ...candidate,
    aggregate: aggregate.aggregate,
    aggregateComplete: aggregate.complete,
  };
}

export function addScores(
  candidate: CandidateRecord,
  scores: Record<string, number | null>,
  tasks: readonly string[],
): CandidateRecord {
  return refreshCandidate(
    { ...candidate, scores: { ...candidate.scores, ...scores } },
    tasks,
  );
}

export function ancestry(
  candidate: CandidateRecord,
  byRef: ReadonlyMap<string, CandidateRecord>,
): Set<string> {
  const result = new Set<string>();
  const pending = [...candidate.ancestors];
  while (pending.length) {
    const ref = pending.pop()!;
    if (result.has(ref)) continue;
    result.add(ref);
    const record = byRef.get(ref);
    if (record) pending.push(...record.ancestors);
  }
  for (const parent of candidate.parents) result.add(parent);
  return result;
}

export function dominates(
  left: CandidateRecord,
  right: CandidateRecord,
  tasks: readonly string[],
): boolean {
  let strictlyBetter = false;
  for (const task of tasks) {
    const a = left.scores[task];
    const b = right.scores[task];
    if (
      typeof a !== 'number' ||
      !Number.isFinite(a) ||
      typeof b !== 'number' ||
      !Number.isFinite(b)
    )
      return false;
    if (a < b) return false;
    if (a > b) strictlyBetter = true;
  }
  return strictlyBetter;
}

export interface ParetoChoice {
  candidates: CandidateRecord[];
  weights: Map<string, number>;
}

/** Prune redundant instance winners, then weight the remaining candidates by wins. */
export function paretoChoice(
  candidates: readonly CandidateRecord[],
  tasks: readonly string[],
): ParetoChoice {
  const unique = [
    ...new Map(
      candidates.map((candidate) => [candidate.ref, candidate]),
    ).values(),
  ];
  const usable = unique.filter(
    (candidate) => candidateAggregate(candidate, tasks).complete,
  );
  if (!usable.length) return { candidates: [], weights: new Map() };
  const winners = new Map<string, string[]>();
  const remainingCounts = new Map<string, number>();
  for (const task of tasks) {
    let best: number | null = null;
    for (const candidate of usable) {
      const score = candidate.scores[task];
      if (typeof score !== 'number') continue;
      if (best === null || score > best) best = score;
    }
    if (best === null) continue;
    const leaders = usable.filter(
      (candidate) => candidate.scores[task] === best,
    );
    remainingCounts.set(task, leaders.length);
    for (const candidate of leaders)
      winners.set(candidate.ref, [...(winners.get(candidate.ref) ?? []), task]);
  }
  const population = usable.filter((candidate) => winners.has(candidate.ref));
  const byRef = new Map(
    population.map((candidate) => [candidate.ref, candidate]),
  );
  const redundant = new Set<string>();
  // Preserve front coverage: remove the lowest aggregate first only while
  // every instance it wins has another
  // surviving leader. A collection of specialists can cover a candidate even
  // when no individual candidate dominates its entire score vector. Equal
  // aggregates retain the order in which task fronts first encounter a leader.
  const ordered = [...winners.keys()]
    .map((ref) => byRef.get(ref)!)
    .sort(
      (left, right) =>
        candidateAggregate(left, tasks).aggregate! -
        candidateAggregate(right, tasks).aggregate!,
    );
  for (const candidate of ordered) {
    const fronts = winners.get(candidate.ref)!;
    if (!fronts.every((task) => remainingCounts.get(task)! > 1)) continue;
    redundant.add(candidate.ref);
    for (const task of fronts)
      remainingCounts.set(task, remainingCounts.get(task)! - 1);
  }
  const remaining = population.filter(
    (candidate) => !redundant.has(candidate.ref),
  );
  const weights = new Map<string, number>();
  for (const candidate of remaining)
    weights.set(candidate.ref, winners.get(candidate.ref)!.length);
  return { candidates: remaining, weights };
}

export function selectCandidate(
  candidates: readonly CandidateRecord[],
  tasks: readonly string[],
  rng: Rng,
): CandidateRecord | null {
  const choice = paretoChoice(candidates, tasks);
  if (!choice.candidates.length) return null;
  const weighted = choice.candidates.map((candidate) => ({
    candidate,
    weight: choice.weights.get(candidate.ref) ?? 1,
  }));
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let pick = rng.next() * total;
  for (const entry of weighted) {
    pick -= entry.weight;
    if (pick < 0) return entry.candidate;
  }
  return weighted[weighted.length - 1]!.candidate;
}

export function bestCandidate(
  candidates: readonly CandidateRecord[],
  tasks: readonly string[],
): { candidate: CandidateRecord | null; score: number | null } {
  let best: CandidateRecord | null = null;
  let bestScore: number | null = null;
  for (const candidate of candidates) {
    const aggregate = candidateAggregate(candidate, tasks);
    if (!aggregate.complete || aggregate.aggregate === null) continue;
    if (best === null || aggregate.aggregate > (bestScore ?? -Infinity)) {
      best = candidate;
      bestScore = aggregate.aggregate;
    }
  }
  return { candidate: best, score: bestScore };
}

export function desirable(
  ancestor: CandidateRecord,
  left: CandidateRecord,
  right: CandidateRecord,
  modules: readonly PromptModule[],
  prompts: Readonly<Record<string, Record<string, string>>>,
): boolean {
  for (const module of modules) {
    const a = prompts[ancestor.ref]?.[module.id];
    const i = prompts[left.ref]?.[module.id];
    const j = prompts[right.ref]?.[module.id];
    if (typeof a !== 'string' || typeof i !== 'string' || typeof j !== 'string')
      throw new Error(`Missing prompt for merge module ${module.id}`);
    if ((a === i && j !== i) || (a === j && i !== j)) return true;
  }
  return false;
}

/** Combine modules relative to a shared ancestor, favoring the higher-scoring parent on conflicts. */
export function mergePrompts(
  modules: readonly PromptModule[],
  ancestor: CandidateRecord,
  left: CandidateRecord,
  right: CandidateRecord,
  prompts: Readonly<Record<string, Record<string, string>>>,
  leftAggregate: number,
  rightAggregate: number,
  rng: Rng,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const module of modules) {
    const a = prompts[ancestor.ref]?.[module.id];
    const i = prompts[left.ref]?.[module.id];
    const j = prompts[right.ref]?.[module.id];
    if (typeof a !== 'string' || typeof i !== 'string' || typeof j !== 'string')
      throw new Error(`Missing prompt for merge module ${module.id}`);
    if (a === i && j !== i) merged[module.id] = j;
    else if (a === j && i !== j) merged[module.id] = i;
    else if (i !== a && j !== a && i !== j) {
      if (leftAggregate > rightAggregate) merged[module.id] = i;
      else if (rightAggregate > leftAggregate) merged[module.id] = j;
      else merged[module.id] = rng.next() < 0.5 ? i : j;
    } else merged[module.id] = i;
  }
  return merged;
}

export function mergeKey(
  ancestor: CandidateRecord,
  left: CandidateRecord,
  right: CandidateRecord,
): string {
  return `${ancestor.ref}:${[left.ref, right.ref].sort().join(':')}`;
}

export function findMerge(
  candidates: readonly CandidateRecord[],
  tasks: readonly string[],
  modules: readonly PromptModule[],
  tried: readonly string[],
  prompts: Readonly<Record<string, Record<string, string>>>,
  rng: Rng,
  attempts = 64,
): MergeChoice | null {
  if (candidates.length < 2) return null;
  const byRef = new Map(
    candidates.map((candidate) => [candidate.ref, candidate]),
  );
  const triedSet = new Set(tried);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const left = candidates[rng.integer(candidates.length)]!;
    const right = candidates[rng.integer(candidates.length)]!;
    if (left.ref === right.ref) continue;
    const leftAncestors = ancestry(left, byRef);
    const rightAncestors = ancestry(right, byRef);
    if (leftAncestors.has(right.ref) || rightAncestors.has(left.ref)) continue;
    const common = [...leftAncestors]
      .filter((ref) => rightAncestors.has(ref))
      .sort();
    for (const ancestorRef of common) {
      const ancestor = byRef.get(ancestorRef);
      if (!ancestor) continue;
      const key = mergeKey(ancestor, left, right);
      if (triedSet.has(key)) continue;
      const a = ancestorAggregate(ancestor, tasks);
      const i = ancestorAggregate(left, tasks);
      const j = ancestorAggregate(right, tasks);
      if (a === null || i === null || j === null || a > Math.min(i, j))
        continue;
      if (!desirable(ancestor, left, right, modules, prompts)) continue;
      return { left, right, ancestor, key };
    }
  }
  return null;
}

function ancestorAggregate(
  candidate: CandidateRecord,
  tasks: readonly string[],
): number | null {
  const result = candidateAggregate(candidate, tasks);
  return result.complete ? result.aggregate : null;
}

export function emptyState(
  settings: ParetoEvolutionSettings,
  selectionTaskIds: string[],
  rng: Rng,
): ParetoEvolutionState {
  return {
    schemaVersion: 'rsi.proposer-pareto-evolution-state/v1',
    seed: settings.seed,
    rng: rng.state,
    feedbackTaskIds: [...settings.feedbackTaskIds],
    selectionTaskIds,
    selectionTruncated: selectionTaskIds.length < settings.paretoSize,
    baselineCandidateRef: null,
    evaluationRefs: [],
    selectionConditions: {},
    candidates: [],
    moduleCursor: 0,
    completedRounds: 0,
    rolloutsUsed: 0,
    mergeAttempts: [],
    rounds: [],
    bestCandidateRef: null,
    bestAggregateScore: null,
    done: false,
    stopReason: null,
    datasetDegenerate: settings.feedbackTaskIds.some((task) =>
      selectionTaskIds.includes(task),
    ),
    weightsChanged: false,
  };
}

export function stateRngFrom(state: ParetoEvolutionState): Rng {
  return stateRng(state);
}
