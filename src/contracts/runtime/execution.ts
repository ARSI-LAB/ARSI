import type {} from './context.js';

export interface BudgetScope {
  id: string;
  signal: AbortSignal;
  limits: { modelCalls: number; elapsedWallMs?: number; evidenceBytes: number };
}
declare module './context.js' {
  interface RuntimeContext {
    experimentId: string;
    scope?: BudgetScope;
    callId: string;
    bindingId: string;
    idempotencyKey: string;
    directory: string;
    signal: AbortSignal;
    cleanup: AbortSignal;
  }
}
