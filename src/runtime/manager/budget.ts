import type {
  FactStore,
  JsonObject,
  RuntimeContext,
} from '../../contracts/index.js';
import { object } from '../../shared/json.js';

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
    private readonly exceeded: (error: Error) => void,
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
        this.exceeded(error);
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
        if (metric === 'modelCalls' && count > scope.limits.modelCalls)
          throw new Error('Reflection modelCalls budget exceeded');
        staged.scopes[scope.id] = { ...state, [metric]: count };
      }
      await this.facts.write('budgets', this.id, {
        ...staged.usage,
        scopes: staged.scopes,
      });
      this.snapshot = staged;
    });
    this.pending = job.catch(() => {});
    await job;
  }
}
