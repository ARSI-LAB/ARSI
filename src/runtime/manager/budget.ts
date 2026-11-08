import type {
  FactStore,
  JsonObject,
  RuntimeContext,
} from '../../contracts/index.js';
import { digest, object } from '../../shared/json.js';
import type { TimeBudgetDecision, TimeBudgetRequest } from '../policy/steps.js';

interface BudgetSnapshot {
  usage: Record<string, number>;
  scopes: Record<string, Record<string, number>>;
}

function counts(value: JsonObject, label: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [metric, count] of Object.entries(value)) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0)
      throw new Error(
        `${label}.${metric}: expected a nonnegative finite number`,
      );
    result[metric] = count;
  }
  return result;
}

/** Serializes charges and owns the persisted experiment and reflection counters. */
export class BudgetLedger {
  private snapshot: BudgetSnapshot = { usage: {}, scopes: {} };
  private pending = Promise.resolve();
  constructor(
    private readonly id: string,
    private readonly facts: FactStore,
    private readonly limits: Record<string, number>,
    private readonly fail: (error: unknown) => void,
  ) {}

  get usage(): Record<string, number> {
    return { ...this.snapshot.usage };
  }

  restore(saved: JsonObject): void {
    const { scopes = {}, ...usage } = saved;
    Object.assign(this.snapshot.usage, counts(usage, 'Budget'));
    for (const [id, value] of Object.entries(object(scopes)))
      this.snapshot.scopes[id] = counts(object(value), `Budget.scopes.${id}`);
  }

  /** Predict the cost of the next work from this experiment's settled call receipts. */
  async timeBudget(
    request: TimeBudgetRequest,
    experimentStartedAt: number,
    context: RuntimeContext,
  ): Promise<TimeBudgetDecision> {
    context.signal.throwIfAborted();
    const ref = digest({ experimentId: this.id, stage: request.stage });
    const kind = 'time-budget-stages';
    let stage: JsonObject;
    try {
      stage = await this.facts.read(kind, ref);
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
      stage = {
        experimentId: this.id,
        stage: request.stage,
        startedAt: Date.now(),
        limitMs: request.limitMs,
      };
      await this.facts.write(kind, ref, stage);
    }
    const startedAt = stage.startedAt;
    if (typeof startedAt !== 'number' || !Number.isSafeInteger(startedAt))
      throw new Error(`Invalid start time for stage ${request.stage}`);
    if (stage.limitMs !== request.limitMs)
      throw new Error(
        `Cannot change the time budget for stage ${request.stage}`,
      );

    const observed = request.actions.map(() => 0);
    const calls =
      this.facts.scan?.('calls') ?? (await this.facts.list('calls'));
    for await (const call of calls) {
      context.signal.throwIfAborted();
      if (
        call.experimentId !== this.id ||
        call.parentCallId !== context.callId ||
        call.status !== 'succeeded' ||
        typeof call.startedAt !== 'string' ||
        typeof call.finishedAt !== 'string'
      )
        continue;
      const duration = Date.parse(call.finishedAt) - Date.parse(call.startedAt);
      if (!Number.isSafeInteger(duration) || duration <= 0) continue;
      const outputStatus =
        call.output &&
        typeof call.output === 'object' &&
        !Array.isArray(call.output)
          ? call.output.status
          : undefined;
      for (const [index, action] of request.actions.entries())
        if (
          action.use === call.bindingId &&
          (action.status === undefined || action.status === outputStatus)
        )
          observed[index] = Math.max(observed[index]!, duration);
    }
    const estimatedMs = request.actions.reduce(
      (total, action, index) => total + (observed[index] || action.initialMs),
      0,
    );
    if (!Number.isSafeInteger(estimatedMs))
      throw new Error(
        'Combined time-budget estimate exceeds the safe integer limit',
      );
    const now = Date.now();
    const available = (
      limit: number | null | undefined,
      started: number,
    ): number =>
      limit == null
        ? Infinity
        : Math.max(0, limit - Math.max(0, now - started));
    const experimentMs = available(
      this.limits.elapsedWallMs,
      experimentStartedAt,
    );
    const stageMs = available(request.limitMs, startedAt);
    const reason =
      experimentMs === 0 || experimentMs < estimatedMs
        ? 'experiment-time'
        : stageMs === 0 || stageMs < estimatedMs
          ? 'stage-time'
          : 'fits';
    const remaining = Math.min(experimentMs, stageMs);
    return {
      fits: reason === 'fits',
      estimatedMs,
      remainingMs: Number.isFinite(remaining) ? remaining : null,
      reason,
    };
  }

  async charge(
    metric: string,
    amount: number,
    context: RuntimeContext,
  ): Promise<void> {
    if (!Number.isFinite(amount) || amount < 0)
      throw new Error('Invalid budget charge');
    const job = this.pending.then(async () => {
      const next = (this.snapshot.usage[metric] ?? 0) + amount;
      const limit = this.limits[metric];
      if (limit !== undefined && next > limit) {
        const error = new Error(`Budget exceeded: ${metric}`);
        error.name = 'ExperimentBudgetExceeded';
        this.fail(error);
        throw error;
      }
      const staged: BudgetSnapshot = {
        usage: { ...this.snapshot.usage, [metric]: next },
        scopes: { ...this.snapshot.scopes },
      };
      const scope = context.scope;
      if (scope) {
        const state = this.snapshot.scopes[scope.id] ?? {};
        const count = (state[metric] ?? 0) + amount;
        if (
          metric === 'modelCalls' &&
          scope.limits.modelCalls !== undefined &&
          count > scope.limits.modelCalls
        )
          throw new Error('Reflection modelCalls budget exceeded');
        staged.scopes[scope.id] = { ...state, [metric]: count };
      }
      try {
        await this.facts.write('budgets', this.id, {
          ...staged.usage,
          scopes: staged.scopes,
        });
      } catch (error) {
        this.fail(error);
        throw error;
      }
      this.snapshot = staged;
    });
    this.pending = job.catch(() => {});
    await job;
  }
}
