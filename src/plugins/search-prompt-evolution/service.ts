import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, matchesGlob } from 'node:path';
import type {
  JsonObject,
  Operation,
  OperationDefinition,
  RuntimeContext,
} from '../../contracts/index.js';
import type {
  SearchFeedback,
  SearchInput,
  SearchOutput,
  SearchWork,
} from '../../contracts/plugin-types/search.js';
import { configSchema, type GepaModule, type GepaConfig } from './schema.js';
import {
  readSearchState,
  writeSearchState,
  type GepaStepResult,
  type RoundPlan,
} from './state.js';
import { digest, object, string, strings } from '../../shared/json.js';
import { metricDefinitionSchema } from '../../contracts/models/measurement.js';
import { parseConfig, validate } from '../../shared/schema.js';
import type { ProposerOutput } from '../../contracts/plugin-types/proposer.js';
import {
  Rng,
  addScores,
  bestCandidate,
  emptyState,
  findMerge,
  mean,
  mergeKey,
  mergePrompts,
  sampleWithoutReplacement,
  scoresFor,
  selectCandidate,
  stateRngFrom,
  type CandidateRecord,
  type EvaluationOutcome,
  type GepaState,
  type RoundReport,
} from './engine.js';

function safePath(path: string): string {
  const parts = path.split('/');
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    parts.some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(
      `GEPA module path is not a safe bundle-relative path: ${path}`,
    );
  return path;
}

function literalModulePattern(path: string): string {
  // Node expands braces before parsing character classes, even in `[{]a,b[}]`.
  // Complement ranges represent braces exactly without triggering expansion;
  // backslash escapes cannot be used because Windows normalizes them as separators.
  return path.replace(/[*?[\]{}()+@]/g, (character) =>
    character === '{'
      ? '[^\u0000-z|-\uffff]'
      : character === '}'
        ? '[^\u0000-|~-\uffff]'
        : `[${character}]`,
  );
}

function validateModules(modules: readonly GepaModule[]): void {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const module of modules) {
    if (ids.has(module.id))
      throw new Error(`GEPA module id is duplicated: ${module.id}`);
    if (paths.has(module.path))
      throw new Error(`GEPA module path is duplicated: ${module.path}`);
    paths.add(module.path);
    ids.add(module.id);
    safePath(module.path);
  }
}

function scoresFromEvaluation(
  evaluation: EvaluationOutcome,
  taskIds: readonly string[],
): Record<string, number | null> {
  return Object.fromEntries(
    taskIds.map((task) => [task, evaluation.scores[task] ?? null]),
  );
}

async function readEvaluation(
  ctx: RuntimeContext,
  state: GepaState,
  measurementRef: string,
  candidateRef: string,
  taskIds: string[],
): Promise<EvaluationOutcome> {
  ctx.signal.throwIfAborted();
  const measurement = await ctx.readMeasurement(measurementRef);
  if (measurement.candidateRef !== candidateRef)
    throw new Error('GEPA measurement belongs to another candidate');
  const reused = state.evaluationRefs.includes(measurementRef);
  const outcome: EvaluationOutcome = {
    comparisonKey: null,
    itemComparisonKeys: {},
    scoreDefinitionRefs: {},
    scores: {},
    rollouts: reused ? 0 : taskIds.length,
  };
  if (!reused) {
    state.evaluationRefs.push(measurementRef);
    state.rolloutsUsed += outcome.rollouts;
  }
  const status =
    typeof measurement.status === 'string' ? measurement.status : 'unknown';
  if (status === 'cancelled')
    throw Object.assign(new Error('GEPA evaluation was cancelled'), {
      status: 'cancelled',
      measurementRef,
    });
  outcome.comparisonKey =
    typeof measurement.comparisonKey === 'string' && measurement.comparisonKey
      ? measurement.comparisonKey
      : null;
  const catalog = object(
    await ctx.artifacts.readJson(string(measurement.itemsRef)),
  );
  const items = Array.isArray(catalog.items)
    ? catalog.items.map((value) => object(value))
    : [];
  const measurementCoverage =
    typeof measurement.coverage === 'string' ? measurement.coverage : 'unknown';
  const executionSucceeded =
    status === 'succeeded' &&
    (measurementCoverage === 'complete' || measurementCoverage === 'partial');
  for (const task of taskIds) {
    const item = items.find((entry) => entry.id === task);
    outcome.itemComparisonKeys[task] =
      item && typeof item.comparisonKey === 'string' && item.comparisonKey
        ? item.comparisonKey
        : null;
    const itemCoverage =
      item && typeof item.coverage === 'string' ? item.coverage : 'unknown';
    const itemUsable =
      item && item.status === 'succeeded' && itemCoverage === 'complete';
    if (!item || !executionSucceeded || !itemUsable) {
      outcome.scores[task] = null;
      continue;
    }
    const metrics = object(item.metrics ?? {});
    const metric = metrics.score === undefined ? null : object(metrics.score);
    const definitionRef =
      metric && typeof metric.definitionRef === 'string'
        ? metric.definitionRef
        : null;
    outcome.scoreDefinitionRefs[task] = definitionRef;
    const scalar =
      metric &&
      metric.status === 'available' &&
      metric.value !== null &&
      typeof metric.value === 'object' &&
      !Array.isArray(metric.value) &&
      object(metric.value).kind === 'scalar'
        ? object(metric.value).value
        : undefined;
    let definitionValid = false;
    if (definitionRef !== null) {
      try {
        const definition = await ctx.artifacts.readJson(definitionRef);
        validate(metricDefinitionSchema, definition, 'GEPA score definition');
        const spec = object(definition);
        definitionValid = spec.id === 'score' && spec.valueKind === 'scalar';
      } catch (error) {
        throwIfCancelled(ctx, error);
      }
    }
    if (
      typeof scalar === 'number' &&
      Number.isFinite(scalar) &&
      definitionValid &&
      outcome.comparisonKey !== null &&
      outcome.itemComparisonKeys[task] !== null
    ) {
      outcome.scores[task] = scalar;
    } else {
      outcome.scores[task] = null;
    }
  }
  return outcome;
}

function throwIfCancelled(context: RuntimeContext, error: unknown): void {
  context.signal.throwIfAborted();
  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    error.status === 'cancelled'
  )
    throw error;
}

function comparisonFailure(
  evaluations: readonly EvaluationOutcome[],
  tasks: readonly string[],
): string | null {
  const first = evaluations[0];
  if (!first || !first.comparisonKey)
    return 'Evaluation comparison conditions were unavailable.';
  for (const evaluation of evaluations) {
    if (evaluation.comparisonKey !== first.comparisonKey)
      return 'The sampled evaluations have incompatible comparison conditions.';
    for (const task of tasks) {
      if (typeof evaluation.scores[task] !== 'number')
        return `Task ${task} comparison score was unavailable.`;
      if (
        !first.itemComparisonKeys[task] ||
        evaluation.itemComparisonKeys[task] !== first.itemComparisonKeys[task]
      )
        return `Task ${task} has incompatible comparison conditions.`;
      if (
        !first.scoreDefinitionRefs[task] ||
        evaluation.scoreDefinitionRefs[task] !== first.scoreDefinitionRefs[task]
      )
        return `Task ${task} has an incompatible score definition.`;
    }
  }
  return null;
}

function scoreConditions(
  evaluation: EvaluationOutcome,
  task: string,
): string | null {
  const comparisonKey = evaluation.comparisonKey;
  const itemComparisonKey = evaluation.itemComparisonKeys[task];
  const definitionRef = evaluation.scoreDefinitionRefs[task];
  return comparisonKey && itemComparisonKey && definitionRef
    ? digest({ comparisonKey, itemComparisonKey, definitionRef })
    : null;
}

function selectionScores(
  state: GepaState,
  evaluation: EvaluationOutcome,
): Record<string, number | null> {
  return Object.fromEntries(
    state.selectionTaskIds.map((task) => {
      const expected = state.selectionConditions[task];
      return [
        task,
        expected && expected === scoreConditions(evaluation, task)
          ? (evaluation.scores[task] ?? null)
          : null,
      ];
    }),
  );
}

async function loadPrompts(
  ctx: RuntimeContext,
  candidate: CandidateRecord,
  modules: readonly GepaModule[],
): Promise<Record<string, string>> {
  const workspace = await ctx.workspaces.create(candidate.artifactRef);
  try {
    const result: Record<string, string> = {};
    for (const module of modules)
      result[module.id] = await readFile(
        join(workspace.directory, safePath(module.path)),
        'utf8',
      );
    return result;
  } finally {
    await ctx.workspaces.release(workspace.ref);
  }
}

async function loadPopulationPrompts(
  ctx: RuntimeContext,
  candidates: readonly CandidateRecord[],
  modules: readonly GepaModule[],
): Promise<Record<string, Record<string, string>>> {
  const result: Record<string, Record<string, string>> = {};
  for (const candidate of candidates)
    result[candidate.ref] = await loadPrompts(ctx, candidate, modules);
  return result;
}

async function commitPrompts(
  ctx: RuntimeContext,
  settings: GepaConfig,
  base: CandidateRecord,
  modules: readonly GepaModule[],
  prompts: Readonly<Record<string, string>>,
): Promise<ProposerOutput> {
  const workspace = await ctx.workspaces.create(base.artifactRef, base.ref);
  try {
    for (const module of modules) {
      const path = join(workspace.directory, safePath(module.path));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, prompts[module.id]!, 'utf8');
    }
    const output = object(
      await ctx.application({
        action: 'commit',
        parentCandidateRef: base.ref,
        editRef: workspace.ref,
        ...(settings.editConstraints === undefined
          ? {}
          : { editConstraints: settings.editConstraints }),
      }),
    );
    if (output.action !== 'commit')
      throw new Error('GEPA Application commit returned another action');
    if (output.status !== 'created' && output.status !== 'no-change')
      throw new Error('GEPA Application commit status is invalid');
    if (output.status === 'no-change')
      return {
        status: 'no-change',
        candidateRef: string(output.candidateRef),
        diffRef: null,
        rationale: 'The merged prompt set did not change the ancestor.',
      };
    return {
      status: 'created',
      candidateRef: string(output.candidateRef),
      diffRef: string(output.diffRef),
      rationale: 'Deterministic ancestry-aware GEPA crossover.',
    };
  } finally {
    await ctx.workspaces.release(workspace.ref);
  }
}

interface CandidateMeta {
  applicationParentRef: string | null;
  parents: string[];
  ancestors: string[];
  origin: 'mutation' | 'crossover';
  createdRound: number;
  moduleIds: string[];
}

function newCandidate(
  ref: string,
  artifactRef: string,
  base: CandidateMeta,
): CandidateRecord {
  return {
    ref,
    artifactRef,
    applicationParentRef: base.applicationParentRef,
    parents: base.parents,
    ancestors: base.ancestors,
    origin: base.origin,
    createdRound: base.createdRound,
    scores: {},
    aggregate: null,
    aggregateComplete: false,
    moduleIds: base.moduleIds,
  };
}

function inheritedAncestors(
  candidates: readonly CandidateRecord[],
  parents: readonly string[],
): string[] {
  const byRef = new Map(
    candidates.map((candidate) => [candidate.ref, candidate]),
  );
  const result = new Set<string>();
  const pending = [...parents];
  while (pending.length) {
    const ref = pending.pop()!;
    if (result.has(ref)) continue;
    result.add(ref);
    const candidate = byRef.get(ref);
    if (candidate) pending.push(...candidate.ancestors, ...candidate.parents);
  }
  return [...result].sort();
}

async function recordCandidateMeta(
  ctx: RuntimeContext,
  ref: string,
  meta: CandidateMeta,
): Promise<CandidateRecord> {
  const record = await ctx.readCandidate(ref);
  return newCandidate(ref, record.artifactRef, meta);
}

function finishState(state: GepaState, settings: GepaConfig): void {
  const best = bestCandidate(state.candidates, state.selectionTaskIds);
  state.bestCandidateRef = best.candidate?.ref ?? null;
  state.bestAggregateScore = best.score;
  const batch = Math.min(settings.minibatchSize, state.feedbackTaskIds.length);
  const minimum = batch * 2 + state.selectionTaskIds.length;
  const observed = best.candidate !== null;
  if (state.rounds.length >= settings.maxRounds) {
    state.done = true;
    state.stopReason = 'round-limit';
  } else if (!observed) {
    state.done = true;
    state.stopReason = 'selection-unavailable';
  } else if (settings.maxRollouts - state.rolloutsUsed < minimum) {
    state.done = true;
    state.stopReason = 'rollout-budget';
  } else {
    state.done = false;
    state.stopReason = null;
  }
}

function result(
  state: GepaState,
  plan: RoundPlan | null = null,
  selectionRequired = false,
): GepaStepResult {
  return { state, plan, selectionRequired };
}

function finishRound(
  state: GepaState,
  settings: GepaConfig,
  report: RoundReport,
): GepaStepResult {
  if (report.status === 'admitted' || report.status === 'rejected')
    state.completedRounds += 1;
  state.rounds.push(report);
  finishState(state, settings);
  return result(state);
}

function roundReport(
  state: GepaState,
  strategy: 'mutation' | 'crossover',
  parents: string[],
  modules: string[],
  tasks: string[],
): RoundReport {
  return {
    round: state.rounds.length,
    strategy,
    status: 'rejected',
    parentRefs: parents,
    ancestorRef: null,
    moduleIds: modules,
    taskIds: tasks,
    parentScores: [],
    proposalScores: [],
    candidateRef: null,
    selectionScores: {},
    rollouts: 0,
    reason: '',
  };
}

async function prepareRound(
  ctx: RuntimeContext,
  state: GepaState,
  settings: GepaConfig,
): Promise<GepaStepResult> {
  finishState(state, settings);
  if (state.done) return result(state);
  const rng = stateRngFrom(state);
  const batch = sampleWithoutReplacement(
    rng,
    state.feedbackTaskIds,
    Math.min(settings.minibatchSize, state.feedbackTaskIds.length),
  );
  const crossoverDue =
    settings.crossoverEvery > 0 &&
    (state.rounds.length + 1) % settings.crossoverEvery === 0;
  const crossoverAffordable =
    settings.maxRollouts - state.rolloutsUsed >=
    batch.length * 3 + state.selectionTaskIds.length;
  if (crossoverDue && crossoverAffordable) {
    const prompts = await loadPopulationPrompts(
      ctx,
      state.candidates,
      settings.modules,
    );
    const choice = findMerge(
      state.candidates,
      state.selectionTaskIds,
      settings.modules,
      state.mergeAttempts,
      prompts,
      rng,
    );
    if (choice) {
      state.mergeAttempts.push(choice.key);
      const merged = mergePrompts(
        settings.modules,
        choice.ancestor,
        choice.left,
        choice.right,
        prompts,
        choice.left.aggregate!,
        choice.right.aggregate!,
        rng,
      );
      // Materialize the deterministic genetic merge through the Application.
      // Its evaluation and admission are separate Policy steps.
      const proposalResult = await commitPrompts(
        ctx,
        settings,
        choice.ancestor,
        settings.modules,
        merged,
      );
      const report = roundReport(
        state,
        'crossover',
        [choice.left.ref, choice.right.ref],
        settings.modules.map((module) => module.id),
        batch,
      );
      report.ancestorRef = choice.ancestor.ref;
      report.mergeKey = mergeKey(choice.ancestor, choice.left, choice.right);
      report.candidateRef = proposalResult.candidateRef;
      state.rng = rng.state;
      return result(state, {
        report,
        proposalInput: null,
        proposalResult,
        candidate: null,
      });
    }
  }
  const parent = selectCandidate(state.candidates, state.selectionTaskIds, rng);
  if (!parent) throw new Error('GEPA mutation has no eligible parent');
  const module =
    settings.modules[state.moduleCursor % settings.modules.length]!;
  state.moduleCursor += 1;
  const constraints = settings.editConstraints ?? {};
  if (
    constraints.allowedPaths !== undefined &&
    !strings(constraints.allowedPaths).some((pattern) =>
      matchesGlob(module.path, pattern),
    )
  )
    throw new Error(
      `The selected module is outside editConstraints.allowedPaths: ${module.path}`,
    );
  const report = roundReport(
    state,
    'mutation',
    [parent.ref],
    [module.id],
    batch,
  );
  if (crossoverDue)
    report.crossoverFallback = crossoverAffordable
      ? 'no-eligible-merge'
      : 'crossover-budget';
  state.rng = rng.state;
  return result(state, {
    report,
    candidate: null,
    proposalResult: null,
    proposalInput: {
      parent: parent.ref,
      goal: `${settings.goal}\nRevise only module ${module.id} (${module.path}) using the supplied evaluation evidence.`,
      editConstraints: {
        ...constraints,
        allowedPaths: [literalModulePattern(module.path)],
        maxChangedFiles:
          typeof constraints.maxChangedFiles === 'number'
            ? Math.min(1, constraints.maxChangedFiles)
            : 1,
      },
    },
  });
}

async function compareRound(
  input: Extract<SearchFeedback, { kind: 'proposal' }>,
  ctx: RuntimeContext,
  state: GepaState,
  plan: RoundPlan,
  settings: GepaConfig,
): Promise<GepaStepResult> {
  const { report } = plan;
  const parentEvaluations: EvaluationOutcome[] = [];
  // A no-change deterministic merge has no source evaluations; a mutation
  // always has the parent feedback that informed its Proposer request.
  const expectedParents =
    report.strategy === 'crossover' && input.proposal.status === 'no-change'
      ? 0
      : report.parentRefs.length;
  if (input.parentMeasurementRefs.length !== expectedParents)
    throw new Error(
      'GEPA comparison requires one measurement per genetic parent',
    );
  for (let index = 0; index < input.parentMeasurementRefs.length; index++) {
    const evaluation = await readEvaluation(
      ctx,
      state,
      input.parentMeasurementRefs[index]!,
      report.parentRefs[index]!,
      report.taskIds,
    );
    parentEvaluations.push(evaluation);
    report.rollouts += evaluation.rollouts;
  }
  report.parentScores = parentEvaluations.flatMap((evaluation) =>
    scoresFor(evaluation.scores, report.taskIds),
  );
  report.candidateRef = input.proposal.candidateRef;
  if (input.proposal.status === 'no-change') {
    report.status = 'no-change';
    report.reason =
      input.proposal.rationale || 'The proposal did not change the candidate.';
    return finishRound(state, settings, report);
  }
  if (!input.proposalMeasurementRef)
    throw new Error(
      'GEPA comparison requires the proposed candidate measurement',
    );
  const candidate = await recordCandidateMeta(
    ctx,
    input.proposal.candidateRef,
    {
      applicationParentRef: report.ancestorRef ?? report.parentRefs[0]!,
      parents: report.parentRefs,
      ancestors: inheritedAncestors(state.candidates, report.parentRefs),
      origin: report.strategy,
      createdRound: report.round,
      moduleIds: report.moduleIds,
    },
  );
  plan.candidate = candidate;
  if (report.strategy === 'mutation') {
    const modules = settings.modules.filter((module) =>
      report.moduleIds.includes(module.id),
    );
    const prompts = await loadPrompts(ctx, candidate, modules);
    if (modules.some((module) => !prompts[module.id]?.trim()))
      throw new Error(
        'The mutated module must contain a nonempty instruction.',
      );
  }
  const proposed = await readEvaluation(
    ctx,
    state,
    input.proposalMeasurementRef,
    candidate.ref,
    report.taskIds,
  );
  report.rollouts += proposed.rollouts;
  report.proposalScores = scoresFor(proposed.scores, report.taskIds);
  const incompatible = comparisonFailure(
    [...parentEvaluations, proposed],
    report.taskIds,
  );
  if (incompatible !== null) {
    report.status = 'evaluation-failed';
    report.reason = incompatible;
    return finishRound(state, settings, report);
  }
  // comparisonFailure established a finite scalar for every sampled task.
  const average = (evaluation: EvaluationOutcome): number =>
    mean(
      report.taskIds.flatMap((task) => {
        const score = evaluation.scores[task];
        return typeof score === 'number' ? [score] : [];
      }),
    )!;
  const before = parentEvaluations.map(average);
  const after = average(proposed);
  report.proposalMean = after;
  if (report.strategy === 'mutation') report.parentMean = before[0]!;
  else {
    report.leftMean = before[0]!;
    report.rightMean = before[1]!;
  }
  const accepted =
    report.strategy === 'mutation'
      ? after > before[0]!
      : after >= Math.max(...before);
  if (!accepted) {
    report.reason =
      report.strategy === 'mutation'
        ? 'The proposal did not strictly improve the sampled minibatch.'
        : 'The merged candidate scored below the better of both genetic source parents.';
    return finishRound(state, settings, report);
  }
  if (state.candidates.some((existing) => existing.ref === candidate.ref)) {
    report.reason = 'The evaluated candidate is already in the population.';
    return finishRound(state, settings, report);
  }
  return result(state, plan, true);
}

async function advanceSearch(
  input: SearchInput,
  context: RuntimeContext,
  settings: GepaConfig,
  configuration: string,
): Promise<GepaStepResult> {
  context.signal.throwIfAborted();
  validateModules(settings.modules);
  if (input.action === 'initialize') {
    if (!input.feedbackTaskIds?.length || !input.selectionTaskIds?.length)
      throw new Error(
        'GEPA initialization requires feedbackTaskIds and selectionTaskIds',
      );
    const initialization = {
      ...settings,
      feedbackTaskIds: input.feedbackTaskIds,
      selectionTaskIds: input.selectionTaskIds,
    };
    const rng = new Rng(settings.seed);
    const sampled = sampleWithoutReplacement(
      rng,
      initialization.selectionTaskIds,
      Math.min(settings.paretoSize, initialization.selectionTaskIds.length),
    );
    const tasks = sampled.slice(0, settings.maxRollouts);
    const state = emptyState(initialization, tasks, rng);
    const initial = await context.readCandidate(input.parent);
    state.selectionTruncated =
      tasks.length < initialization.selectionTaskIds.length;
    state.baselineCandidateRef = initial.ref;
    state.candidates = [
      {
        ref: initial.ref,
        artifactRef: initial.artifactRef,
        applicationParentRef: null,
        parents: [],
        ancestors: [],
        origin: 'base',
        createdRound: 0,
        scores: {},
        aggregate: null,
        aggregateComplete: false,
        moduleIds: settings.modules.map((module) => module.id),
      },
    ];
    return result(state);
  }
  const { state, plan } = await readSearchState(
    context,
    input.stateRef,
    configuration,
  );
  if (input.action === 'suggest') return prepareRound(context, state, settings);
  const feedback = input.feedback;
  if (feedback.kind === 'proposal') {
    if (!plan || input.workId !== `proposal:${plan.report.round}`)
      throw new Error('GEPA feedback does not match the pending proposal work');
    return compareRound(feedback, context, state, plan, settings);
  }
  const expectedWorkId = plan ? `selection:${plan.report.round}` : 'initial';
  if (input.workId !== expectedWorkId)
    throw new Error('GEPA feedback does not match the pending evaluation work');
  const expectedMeasurements = state.selectionTaskIds.length ? 1 : 0;
  if (feedback.measurementRefs.length !== expectedMeasurements)
    throw new Error(
      'GEPA feedback requires one measurement per requested evaluation',
    );
  const measurementRef = feedback.measurementRefs[0];
  if (!plan) {
    if (state.selectionTaskIds.length) {
      if (!measurementRef)
        throw new Error('GEPA initial selection requires a measurement');
      const initial = state.candidates[0]!;
      const evaluation = await readEvaluation(
        context,
        state,
        measurementRef,
        initial.ref,
        state.selectionTaskIds,
      );
      state.selectionConditions = Object.fromEntries(
        state.selectionTaskIds.map((task) => [
          task,
          scoreConditions(evaluation, task),
        ]),
      );
      state.candidates[0] = addScores(
        initial,
        scoresFromEvaluation(evaluation, state.selectionTaskIds),
        state.selectionTaskIds,
      );
    }
    finishState(state, settings);
    return result(state);
  }
  const { candidate, report } = plan;
  if (!candidate)
    throw new Error('GEPA selection requires a compared candidate');
  const selection = await readEvaluation(
    context,
    state,
    measurementRef!,
    candidate.ref,
    state.selectionTaskIds,
  );
  report.rollouts += selection.rollouts;
  report.selectionScores = selectionScores(state, selection);
  if (Object.values(report.selectionScores).some((score) => score === null)) {
    report.status = 'evaluation-failed';
    report.reason =
      'Selection scores were unavailable or incomparable with the initial selection conditions.';
  } else {
    state.candidates.push(
      addScores(candidate, report.selectionScores, state.selectionTaskIds),
    );
    report.status = 'admitted';
    report.reason =
      report.strategy === 'mutation'
        ? 'Strict minibatch improvement; candidate added to the population.'
        : 'Merged candidate matched or improved on both source parents; candidate added to the population.';
  }
  return finishRound(state, settings, report);
}

function searchResult(state: GepaState, settings: GepaConfig): JsonObject {
  return {
    baselineCandidateRef: state.baselineCandidateRef,
    bestCandidateRef: state.bestCandidateRef,
    bestAggregateScore: state.bestAggregateScore,
    completedRounds: state.completedRounds,
    rolloutsUsed: state.rolloutsUsed,
    maxRollouts: settings.maxRollouts,
    feedbackTaskIds: state.feedbackTaskIds,
    selectionTaskIds: state.selectionTaskIds,
    datasetDegenerate: state.datasetDegenerate,
    stopReason: state.stopReason,
    candidates: state.candidates,
    rounds: state.rounds,
    weightsChanged: false,
  };
}

function requestedWork(
  input: SearchInput,
  step: GepaStepResult,
): SearchWork | null {
  const { state, plan } = step;
  if (input.action === 'initialize')
    return {
      kind: 'evaluation',
      id: 'initial',
      evaluations: state.selectionTaskIds.length
        ? [{ candidateRef: input.parent, taskIds: state.selectionTaskIds }]
        : [],
    };
  if (step.selectionRequired)
    return {
      kind: 'evaluation',
      id: `selection:${plan!.report.round}`,
      evaluations: [
        { candidateRef: plan!.candidate!.ref, taskIds: state.selectionTaskIds },
      ],
    };
  if (!plan) return null;
  const work = {
    kind: 'proposal' as const,
    id: `proposal:${plan.report.round}`,
    parentRefs: plan.report.parentRefs,
    taskIds: plan.report.taskIds,
  };
  if (plan.proposalInput)
    return {
      ...work,
      proposalInput: { ...plan.proposalInput, evidenceRefs: [] },
      proposalResult: null,
    };
  if (!plan.proposalResult) throw new Error('GEPA round plan has no proposal');
  return { ...work, proposalInput: null, proposalResult: plan.proposalResult };
}

export const createPromptEvolutionSearch: OperationDefinition<
  SearchInput,
  SearchOutput,
  GepaConfig
>['create'] = async (raw): Promise<Operation<SearchInput, SearchOutput>> => {
  const settings = parseConfig<GepaConfig>(configSchema, raw, 'GEPA config');
  const configuration = digest(settings);
  return {
    async execute(input, context): Promise<SearchOutput> {
      const step = await advanceSearch(input, context, settings, configuration);
      const { state } = step;
      const stateRef = await writeSearchState(context, configuration, step);
      return {
        stateRef,
        done: state.done,
        iterationLimit: settings.maxRounds,
        work: requestedWork(input, step),
        result: state.done ? searchResult(state, settings) : null,
      };
    },
    async dispose(): Promise<void> {},
  };
};
