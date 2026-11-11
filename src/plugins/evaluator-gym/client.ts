import type { JsonObject, JsonValue } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';

/** The bounded slice of the Gym `eval_service` contract that ember-rsi consumes. */
export interface GymEvalRequest {
  candidateId: string;
  candidateDigest?: string;
  adapter: string;
  benchmark: string;
  split: string;
  tier: string;
  seed: number;
  taskIds?: readonly string[];
  budget?: GymEvalBudget;
  harnessManifest?: string;
}

export interface GymEvalBudget {
  maxRollouts?: number;
  timeoutS?: number;
}

export type GymEvalStatus =
  | 'queued'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'budget_exhausted';

export interface GymEvalItemCheck {
  id: string;
  status: string;
  score: number | null;
  reason: string | null;
}

export interface GymEvalItemDiagnostic {
  kind: string;
  code: string | null;
  message: string;
  truncated: boolean;
}

export interface GymEvalItem {
  taskId: string;
  rollouts: number;
  rewardMean: number | null;
  passRate: number | null;
  rolloutsFailed: number;
  checks: readonly GymEvalItemCheck[];
  diagnostics: readonly GymEvalItemDiagnostic[];
  truncated: boolean;
}

export interface GymEvalOutcome {
  evalId: string;
  status: GymEvalStatus;
  rewardMean: number | null;
  passRate: number | null;
  rollouts: number;
  rolloutsFailed: number;
  trusted: boolean | null;
  experimentProfileId: string | null;
  datasetVersion: string | null;
  harnessManifestDigest: string | null;
  environmentDigest: string | null;
  evaluationDigest: string | null;
  perRolloutRef: string | null;
  items: readonly GymEvalItem[];
  totalTokens: number;
  wallTimeS: number;
  errorCode: string | null;
  errorMessage: string | null;
  errorFixHint: string | null;
  warnings: readonly string[];
}

export interface GymClientOptions {
  baseUrl: string;
  intervalMs?: number;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

export interface GymEvaluateOptions {
  /** Persist the eval id before polling so an interrupted run is recoverable. */
  onSubmitted?: (evalId: string) => Promise<void> | void;
}

export class GymHttpError extends Error {
  constructor(
    readonly path: string,
    readonly statusCode: number,
    readonly body: string,
  ) {
    super(`Gym ${path} failed with HTTP ${statusCode}: ${body.slice(0, 300)}`);
    this.name = 'GymHttpError';
  }
}

export class GymEvaluationError extends Error {
  constructor(
    message: string,
    readonly details: {
      phase: 'submit' | 'poll';
      evalId: string | null;
      submitted: boolean;
      outcomeUnknown: boolean;
    },
  ) {
    super(message);
    this.name = 'GymEvaluationError';
  }
}

export class GymEvaluationClient {
  private readonly baseUrl: string;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GymClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.intervalMs = options.intervalMs ?? 2000;
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30 * 1000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async evaluate(
    request: GymEvalRequest,
    signal: AbortSignal,
    options: GymEvaluateOptions = {},
  ): Promise<GymEvalOutcome> {
    let evalId: string | null = null;
    let submitted = false;
    try {
      const first = await this.post('/gym_evaluate', body(request), signal);
      evalId = stringOf(first.eval_id, 'eval_id');
      if (statusOf(first.status) === 'rejected')
        throw new GymEvaluationError(
          `Gym rejected the evaluation: ${errorMessage(first)}`,
          { phase: 'submit', evalId, submitted: false, outcomeUnknown: false },
        );
      submitted = true;
      await options.onSubmitted?.(evalId);
      return await this.finish(first, evalId, signal);
    } catch (error) {
      if (error instanceof GymEvaluationError) throw error;
      throw new GymEvaluationError(
        error instanceof Error ? error.message : String(error),
        {
          phase: submitted ? 'poll' : 'submit',
          evalId,
          submitted,
          outcomeUnknown: submitted,
        },
      );
    }
  }

  /** Resume polling for an eval id persisted by a previous attempt. */
  async awaitResult(
    evalId: string,
    signal: AbortSignal,
  ): Promise<GymEvalOutcome> {
    const deadline = Date.now() + this.timeoutMs;
    try {
      return await this.finish(null, evalId, signal, deadline);
    } catch (error) {
      if (error instanceof GymEvaluationError) throw error;
      throw new GymEvaluationError(
        error instanceof Error ? error.message : String(error),
        { phase: 'poll', evalId, submitted: true, outcomeUnknown: true },
      );
    }
  }

  private async finish(
    raw: JsonObject | null,
    evalId: string,
    signal: AbortSignal,
    deadline = Date.now() + this.timeoutMs,
  ): Promise<GymEvalOutcome> {
    let current = raw;
    while (current === null || statusOf(current.status) === 'queued') {
      if (Date.now() >= deadline)
        throw new GymEvaluationError(
          `Gym evaluation ${evalId} did not finish within ${this.timeoutMs}ms`,
          { phase: 'poll', evalId, submitted: true, outcomeUnknown: true },
        );
      await sleep(this.intervalMs, signal);
      current = await this.resultOrNull(evalId, signal);
    }
    return outcome(current);
  }
  async result(evalId: string, signal: AbortSignal): Promise<JsonObject> {
    const value = await this.resultOrNull(evalId, signal);
    if (value !== null) return value;
    throw new GymEvaluationError(`Gym has no result for ${evalId}`, {
      phase: 'poll',
      evalId,
      submitted: true,
      outcomeUnknown: true,
    });
  }
  private async resultOrNull(
    evalId: string,
    signal: AbortSignal,
  ): Promise<JsonObject | null> {
    const body = await this.post('/results', { eval_id: evalId }, signal);
    return body.found === true ? object(body.result, 'result') : null;
  }

  private async post(
    path: string,
    body: JsonObject,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const response = await this.fetchImpl(this.baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: combined,
    });
    const text = await response.text();
    if (!response.ok) throw new GymHttpError(path, response.status, text);
    return object(JSON.parse(text), `${path} response`);
  }
}

function body(request: GymEvalRequest): JsonObject {
  return {
    candidate_id: request.candidateId,
    ...(request.candidateDigest === undefined
      ? {}
      : { candidate_digest: request.candidateDigest }),
    adapter: request.adapter,
    benchmark: request.benchmark,
    split: request.split,
    tier: request.tier,
    seed: request.seed,
    ...(request.taskIds === undefined
      ? {}
      : { task_ids: [...request.taskIds] }),
    ...(request.budget === undefined
      ? {}
      : {
          budget: {
            ...(request.budget.maxRollouts === undefined
              ? {}
              : { max_rollouts: request.budget.maxRollouts }),
            ...(request.budget.timeoutS === undefined
              ? {}
              : { timeout_s: request.budget.timeoutS }),
          },
        }),
    ...(request.harnessManifest === undefined
      ? {}
      : { harness_manifest: request.harnessManifest }),
  };
}

function outcome(raw: JsonObject): GymEvalOutcome {
  const metrics = optionalObject(raw.metrics);
  const cost = optionalObject(raw.cost);
  const guard = optionalObject(raw.overfit_guard);
  const error = optionalObject(raw.error);
  return {
    evalId: stringOf(raw.eval_id, 'eval_id'),
    status: statusOf(raw.status),
    rewardMean: numberOrNull(metrics?.reward_mean),
    passRate: numberOrNull(metrics?.pass_rate),
    rollouts: integerOf(metrics?.rollouts),
    rolloutsFailed: integerOf(metrics?.rollouts_failed),
    trusted: booleanOrNull(guard?.trusted),
    experimentProfileId: stringOrNull(raw.experiment_profile_id),
    datasetVersion: stringOrNull(raw.dataset_version),
    harnessManifestDigest: stringOrNull(raw.harness_manifest_digest),
    environmentDigest: stringOrNull(raw.environment_digest),
    evaluationDigest: stringOrNull(raw.evaluation_digest),
    perRolloutRef: stringOrNull(raw.per_rollout_ref),
    items: Array.isArray(raw.items)
      ? raw.items
          .map(itemOf)
          .filter((item): item is GymEvalItem => item !== null)
      : [],
    totalTokens: integerOf(cost?.total_tokens),
    wallTimeS: numberOrNull(cost?.wall_time_s) ?? 0,
    errorCode: stringOrNull(error?.code),
    errorMessage: stringOrNull(error?.message),
    errorFixHint: stringOrNull(error?.fix_hint),
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.map((value) => String(value))
      : [],
  };
}

function itemOf(value: JsonValue): GymEvalItem | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  const raw = value as JsonObject;
  const taskId = stringOrNull(raw.task_id);
  if (taskId === null || taskId.length === 0) return null;
  return {
    taskId,
    rollouts: integerOf(raw.rollouts),
    rewardMean: numberOrNull(raw.reward_mean),
    passRate: numberOrNull(raw.pass_rate),
    rolloutsFailed: integerOf(raw.rollouts_failed),
    checks: Array.isArray(raw.checks)
      ? raw.checks
          .map(checkOf)
          .filter((check): check is GymEvalItemCheck => check !== null)
      : [],
    diagnostics: Array.isArray(raw.diagnostics)
      ? raw.diagnostics
          .map(diagnosticOf)
          .filter(
            (diagnostic): diagnostic is GymEvalItemDiagnostic =>
              diagnostic !== null,
          )
      : [],
    truncated: raw.truncated === true,
  };
}

function checkOf(value: JsonValue): GymEvalItemCheck | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  const raw = value as JsonObject;
  const id = stringOrNull(raw.id);
  const status = stringOrNull(raw.status);
  if (id === null || status === null) return null;
  return {
    id,
    status,
    score: numberOrNull(raw.score),
    reason: stringOrNull(raw.reason),
  };
}

function diagnosticOf(value: JsonValue): GymEvalItemDiagnostic | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  const raw = value as JsonObject;
  const kind = stringOrNull(raw.kind);
  const message = stringOrNull(raw.message);
  if (kind === null || message === null) return null;
  return {
    kind,
    code: stringOrNull(raw.code),
    message,
    truncated: raw.truncated === true,
  };
}

function errorMessage(raw: JsonObject): string {
  const error = optionalObject(raw.error);
  return stringOrNull(error?.message) ?? 'no error payload';
}

function statusOf(value: JsonValue | undefined): GymEvalStatus {
  if (
    value === 'queued' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'rejected' ||
    value === 'budget_exhausted'
  )
    return value;
  throw new Error(`Gym returned an unknown status: ${String(value)}`);
}

function optionalObject(value: JsonValue | undefined): JsonObject | null {
  return value === undefined || value === null ? null : object(value);
}

function stringOf(value: JsonValue | undefined, label: string): string {
  return string(value, label);
}

function stringOrNull(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integerOf(value: JsonValue | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function booleanOrNull(value: JsonValue | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
