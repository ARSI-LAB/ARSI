import type { JsonObject, JsonValue } from '../../contracts/index.js';
import { object, string } from '../../shared/json.js';
import {
  GymHttpClient,
  GymHttpError,
  type GymHttpClientOptions,
  optionalObject,
  sleep,
} from '../shared/gym/http.js';

export interface GymPromotionRequest {
  candidateId: string;
  candidateDigest: string;
  adapter: string;
  benchmark: string;
  seed: number;
  datasetVersion?: string;
  budget?: { maxRollouts?: number; timeoutS?: number };
}

export type GymPromotionState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'budget_exhausted'
  | 'failed'
  | 'rejected';

export interface GymPromotionReport {
  promotionId: string;
  evalId: string;
  candidateId: string;
  candidateDigest: string;
  adapter: string;
  benchmark: string;
  split: string;
  tier: string;
  seed: number | null;
  status: string;
  rewardMean: number | null;
  passRate: number | null;
  rollouts: number | null;
  rolloutsFailed: number | null;
  manifestSchemaVersion: number | null;
  harnessManifestDigest: string | null;
  environmentDigest: string | null;
  evaluationDigest: string | null;
  experimentProfileId: string | null;
  datasetVersion: string | null;
  generatedAt: string | null;
}

export interface GymPromotionOutcome {
  promotionId: string;
  state: GymPromotionState;
  reused: boolean;
  report: GymPromotionReport | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface GymPromotionClientOptions extends GymHttpClientOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

export interface GymPromoteOptions {
  /** Called after Gym accepts or reuses a promotion, before polling begins. */
  onAccepted?: (accepted: {
    promotionId: string;
    reused: boolean;
  }) => Promise<void> | void;
}

export class GymPromotionError extends Error {
  constructor(
    message: string,
    readonly details: {
      phase: 'submit' | 'poll';
      promotionId: string | null;
      submitted: boolean;
      outcomeUnknown: boolean;
    },
  ) {
    super(message);
    this.name = 'GymPromotionError';
  }
}

export class GymPromotionClient {
  private readonly http: GymHttpClient;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;

  constructor(options: GymPromotionClientOptions) {
    this.http = new GymHttpClient(options);
    this.intervalMs = options.intervalMs ?? 5000;
    this.timeoutMs = options.timeoutMs ?? 60 * 60 * 1000;
  }

  async promote(
    request: GymPromotionRequest,
    signal: AbortSignal,
    options: GymPromoteOptions = {},
  ): Promise<GymPromotionOutcome> {
    let promotionId: string | null = null;
    let submitted = false;
    try {
      const first = await this.http.post('/promotion', body(request), signal);
      promotionId = stringOf(first.promotion_id, 'promotion_id');
      const state = stateOf(first.state);
      const reused = first.reused === true;
      submitted = true;
      await options.onAccepted?.({ promotionId, reused });
      const report = reportOrNull(first.report);
      if (report !== null || terminal(state))
        return outcome(promotionId, state, reused, report, first.error);
      return await this.poll(promotionId, signal, reused);
    } catch (error) {
      if (error instanceof GymHttpError) {
        const conflictId = conflictPromotionId(error.statusCode, error.body);
        if (conflictId !== null) {
          promotionId = conflictId;
          submitted = true;
          await options.onAccepted?.({ promotionId, reused: true });
          return await this.poll(promotionId, signal, true);
        }
        const phase = error.path === '/promotion' ? 'submit' : 'poll';
        const requestSubmitted = phase === 'poll' || error.statusCode >= 500;
        throw new GymPromotionError(error.message, {
          phase,
          promotionId,
          submitted: requestSubmitted,
          outcomeUnknown: requestSubmitted,
        });
      }
      if (error instanceof GymPromotionError) throw error;
      throw new GymPromotionError(
        error instanceof Error ? error.message : String(error),
        {
          phase: submitted ? 'poll' : 'submit',
          promotionId,
          submitted,
          outcomeUnknown: submitted,
        },
      );
    }
  }

  private async poll(
    promotionId: string,
    signal: AbortSignal,
    reused: boolean,
  ): Promise<GymPromotionOutcome> {
    const deadline = Date.now() + this.timeoutMs;
    while (true) {
      signal.throwIfAborted();
      if (Date.now() >= deadline)
        throw new GymPromotionError(
          `Gym promotion ${promotionId} did not finish within ${this.timeoutMs}ms`,
          {
            phase: 'poll',
            promotionId,
            submitted: true,
            outcomeUnknown: true,
          },
        );
      await sleep(this.intervalMs, signal);
      const raw = await this.http.get(
        `/promotion/${encodeURIComponent(promotionId)}`,
        signal,
      );
      const state = stateOf(raw.state);
      const report = reportOrNull(raw.report);
      if (terminal(state))
        return outcome(promotionId, state, reused, report, raw.error);
    }
  }
}

function body(request: GymPromotionRequest): JsonObject {
  return {
    candidate_id: request.candidateId,
    candidate_digest: request.candidateDigest,
    adapter: request.adapter,
    benchmark: request.benchmark,
    tier: 'full',
    seed: request.seed,
    ...(request.datasetVersion === undefined
      ? {}
      : { dataset_version: request.datasetVersion }),
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
  };
}

function outcome(
  promotionId: string,
  state: GymPromotionState,
  reused: boolean,
  report: GymPromotionReport | null,
  rawError: JsonValue | undefined,
): GymPromotionOutcome {
  const error = optionalObject(rawError);
  return {
    promotionId,
    state,
    reused,
    report,
    errorCode: stringOrNull(error?.code),
    errorMessage: stringOrNull(error?.message),
  };
}

function reportOrNull(value: JsonValue | undefined): GymPromotionReport | null {
  if (value === undefined || value === null) return null;
  const raw = object(value, 'promotion report');
  const metrics = optionalObject(raw.metrics);
  return {
    promotionId: stringOf(raw.promotion_id, 'promotion report.promotion_id'),
    evalId: stringOf(raw.eval_id, 'promotion report.eval_id'),
    candidateId: stringOf(raw.candidate_id, 'promotion report.candidate_id'),
    candidateDigest: stringOf(
      raw.candidate_digest,
      'promotion report.candidate_digest',
    ),
    adapter: stringOf(raw.adapter, 'promotion report.adapter'),
    benchmark: stringOf(raw.benchmark, 'promotion report.benchmark'),
    split: stringOf(raw.split, 'promotion report.split'),
    tier: stringOf(raw.tier, 'promotion report.tier'),
    seed: integerOrNull(raw.seed),
    status: stringOf(raw.status, 'promotion report.status'),
    rewardMean: numberOrNull(metrics?.reward_mean),
    passRate: numberOrNull(metrics?.pass_rate),
    rollouts: integerOrNull(metrics?.rollouts),
    rolloutsFailed: integerOrNull(metrics?.rollouts_failed),
    manifestSchemaVersion: integerOrNull(raw.manifest_schema_version),
    harnessManifestDigest: stringOrNull(raw.harness_manifest_digest),
    environmentDigest: stringOrNull(raw.environment_digest),
    evaluationDigest: stringOrNull(raw.evaluation_digest),
    experimentProfileId: stringOrNull(raw.experiment_profile_id),
    datasetVersion: stringOrNull(raw.dataset_version),
    generatedAt: stringOrNull(raw.generated_at),
  };
}

function terminal(state: GymPromotionState): boolean {
  return state !== 'queued' && state !== 'running';
}

function stateOf(value: JsonValue | undefined): GymPromotionState {
  if (
    value === 'queued' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'budget_exhausted' ||
    value === 'failed' ||
    value === 'rejected'
  )
    return value;
  throw new Error(`Gym returned an unknown promotion state: ${String(value)}`);
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

function integerOrNull(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : null;
}

function conflictPromotionId(status: number, text: string): string | null {
  if (status !== 409) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
    const detail = (parsed as { detail?: unknown }).detail;
    if (detail === null || typeof detail !== 'object' || Array.isArray(detail))
      return null;
    const promotionId = (detail as { promotion_id?: unknown }).promotion_id;
    return typeof promotionId === 'string' && promotionId.length > 0
      ? promotionId
      : null;
  } catch {
    return null;
  }
}
