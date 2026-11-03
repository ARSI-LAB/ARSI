import type { Context, Events } from '@deepseek-ai/cordis';
import type { RuntimeContext } from './context.js';

/** Native Cordis publishing, including explicit dispatch `this` and filtering. */
export type EventPublisher = Pick<
  Context,
  'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'
>;

/** Instance-owned subscriptions; publishing keeps the native Cordis overloads. */
type EventHandler<Name extends keyof Events> = {
  [Key in keyof Events]: (
    this: ThisParameterType<Events[Key]>,
    ...args: [...Parameters<Events[Key]>, RuntimeContext]
  ) => ReturnType<Events[Key]>;
}[Name];

export interface EventPipeline extends EventPublisher {
  on<Name extends keyof Events>(
    name: Name,
    handler: EventHandler<NoInfer<Name>>,
  ): () => boolean;
}

export interface ExperimentEventInfo {
  readonly experimentId: string;
  readonly recipeId: string;
  readonly policyId: string;
  readonly resumed: boolean;
}
export interface ExperimentFinishedEvent {
  readonly experimentId: string;
  readonly recipeId: string;
  readonly status: 'succeeded' | 'failed' | 'cancelled';
}
export interface CallEventInfo {
  readonly experimentId: string;
  readonly callId: string;
  readonly bindingId: string;
  readonly parentCallId: string;
  readonly path: string;
  readonly bindingRef: string;
  readonly revisionRef: string | null;
}
export interface BeforeCallEvent extends CallEventInfo {
  readonly status: 'running';
}
export type CallDecision =
  | { kind: 'proceed' }
  | { kind: 'reject'; reason: string };
export interface CallSucceededEvent extends CallEventInfo {
  readonly status: 'succeeded';
  readonly measurementRef?: string;
}
export interface CallFailedEvent extends CallEventInfo {
  readonly status: 'failed';
}
export interface CallCancelledEvent extends CallEventInfo {
  readonly status: 'cancelled';
}
export interface CallUnknownEvent extends CallEventInfo {
  readonly status: 'unknown';
}
export interface PolicyEventInfo {
  readonly experimentId: string;
  readonly policyId: string;
  readonly policyScopeId: string;
  readonly checkpointRef: string;
}
export interface PolicyStartedEvent extends PolicyEventInfo {
  readonly resumed: boolean;
}
export interface PolicyStepCompletedEvent extends PolicyEventInfo {
  readonly stepPath: string;
  readonly stage: 'init' | 'loop' | 'finish';
}
export interface PolicyBoundaryCompletedEvent extends PolicyEventInfo {
  readonly boundary: 'iteration-completed' | 'policy-completed';
  readonly iteration?: number;
}
export interface CandidateRecordedEvent {
  readonly experimentId: string;
  readonly callId: string;
  readonly bindingId: string;
  readonly candidateRef: string;
  readonly parentRef: string | null;
}
export interface MeasurementRecordedEvent {
  readonly experimentId: string;
  readonly callId: string;
  readonly bindingId: string;
  readonly measurementRef: string;
}
export interface RevisionActivatedEvent {
  readonly experimentId: string;
  readonly activationId: string;
  readonly bindingIds: readonly string[];
  readonly revisionRefs: Readonly<Record<string, string>>;
  readonly policyRevisionRef?: string;
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** @mode serial Prepare before initialization; an error prevents execution. */
    'rsi/before-experiment'(
      event: ExperimentEventInfo,
    ): undefined | Promise<undefined>;
    /** @mode emit Notify a saved running record; errors are diagnostics. */
    'rsi/experiment-started'(event: ExperimentEventInfo): void;
    /** @mode parallel Finish after terminal persistence; errors are diagnostics. */
    'rsi/experiment-finished'(
      event: ExperimentFinishedEvent,
    ): void | Promise<void>;
    /** @mode waterfall Decide admission; Manager consumes the final result. */
    'rsi/before-call'(
      event: BeforeCallEvent,
      next: () => Promise<CallDecision>,
    ): Promise<CallDecision>;
    /** @mode parallel Await processing; failures do not rewrite the saved receipt. */
    'rsi/call-succeeded'(event: CallSucceededEvent): void | Promise<void>;
    /** @mode parallel Preserve the original failure on notification errors. */
    'rsi/call-failed'(event: CallFailedEvent): void | Promise<void>;
    /** @mode parallel Preserve cancellation on notification errors. */
    'rsi/call-cancelled'(event: CallCancelledEvent): void | Promise<void>;
    /** @mode parallel Preserve unknown side effects; do not retry automatically. */
    'rsi/call-unknown'(event: CallUnknownEvent): void | Promise<void>;
    /** @mode serial Prepare after identity validation and before init. */
    'rsi/policy-started'(
      event: PolicyStartedEvent,
    ): undefined | Promise<undefined>;
    /** @mode emit Notify a saved step; errors are diagnostics. */
    'rsi/policy-step-completed'(event: PolicyStepCompletedEvent): void;
    /** @mode serial Await extensions after checkpoint and revision activation. */
    'rsi/policy-boundary-completed'(
      event: PolicyBoundaryCompletedEvent,
    ): undefined | Promise<undefined>;
    /** @mode emit Notify validated output; errors are diagnostics. */
    'rsi/policy-completed'(event: PolicyEventInfo): void;
    /** @mode emit Notify a saved candidate; errors are diagnostics. */
    'rsi/candidate-recorded'(event: CandidateRecordedEvent): void;
    /** @mode emit Notify a saved measurement; errors are diagnostics. */
    'rsi/measurement-recorded'(event: MeasurementRecordedEvent): void;
    /** @mode emit Notify committed activation; errors do not roll it back. */
    'rsi/revision-activated'(event: RevisionActivatedEvent): void;
  }
}
