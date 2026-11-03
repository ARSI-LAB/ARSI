import { Context, type Events } from '@deepseek-ai/cordis';
import { isPromise } from 'node:util/types';
import { randomUUID } from 'node:crypto';
import type {
  RuntimeContext,
  EventPublisher,
  EventPipeline,
} from '../../contracts/index.js';

export interface EventDiagnostic {
  eventName: string;
  bindingId?: string;
  listenerId?: string;
  error: unknown;
}
export interface ManagedEventsOptions {
  context(
    bindingId: string,
    listenerId: string,
    signal: AbortSignal,
  ): RuntimeContext;
  diagnostic(info: EventDiagnostic): void | Promise<void>;
}

/** Ownership only: all listener selection and dispatch algorithms remain Cordis's. */
export class EventScope {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly disposers: (() => boolean)[] = [];
  readonly waiters = new Set<() => void>();
  references = 0;
  active = false;
  closed = false;
  readonly subscriptions = new Set<{
    name: keyof Events;
    install(): () => boolean;
  }>();
  constructor(
    readonly bindingId: string,
    readonly context: Context,
    readonly event: EventPipeline,
  ) {}
}

type DispatchMode = keyof EventPublisher;
const ordinaryNotifications = new Set<keyof Events>([
  'rsi/experiment-started',
  'rsi/policy-step-completed',
  'rsi/policy-completed',
  'rsi/candidate-recorded',
  'rsi/measurement-recorded',
  'rsi/revision-activated',
]);

/** One independent Cordis root per experiment, with binding-owned subscriptions. */
export class ManagedEvents {
  readonly context = new Context();
  readonly event: EventPipeline;
  private readonly slots = new Map<string, EventScope | undefined>();
  private readonly scopes = new Set<EventScope>();
  private readonly waiters = new Set<() => void>();
  private references = 0;
  private sequence = 0;
  private readonly executionId = randomUUID();
  private accepting = true;

  constructor(private readonly options: ManagedEventsOptions) {
    // The dynamic forwarding boundary preserves all native overloads, including
    // explicit `this`; no dispatch or return-value protocol is reimplemented.
    const method = <Mode extends DispatchMode>(
      mode: Mode,
    ): EventPublisher[Mode] =>
      ((...args: unknown[]) =>
        this.dispatch(mode, args)) as EventPublisher[Mode];
    this.event = {
      emit: method('emit'),
      parallel: method('parallel'),
      serial: method('serial'),
      bail: method('bail'),
      waterfall: method('waterfall'),
      on() {
        throw new Error('Event subscriptions require a plugin instance');
      },
    };
  }

  prepare(bindingId: string): EventScope {
    if (!this.accepting)
      throw new Error('Experiment event admission is closed');
    const scope: EventScope = new EventScope(
      bindingId,
      this.context.extend({ bindingId }),
      {
        ...this.event,
        on: (name, handler) => this.subscribe(scope, name, handler),
      },
    );
    this.scopes.add(scope);
    return scope;
  }

  activate(scope: EventScope): void {
    if (!this.accepting)
      throw new Error('Experiment event admission is closed');
    if (scope.closed) throw new Error('Plugin event scope is closed');
    const previous = this.slots.get(scope.bindingId);
    if (previous === scope && scope.active) return;
    if (previous) {
      previous.active = false;
      previous.closed = true;
    }
    // Map.set retains an existing binding's original registration position.
    this.slots.set(scope.bindingId, scope);
    scope.active = true;
    this.install();
  }

  deactivate(scope: EventScope): void {
    scope.closed = true;
    if (!scope.active) return;
    scope.active = false;
    this.install();
  }

  /** Forget a retired scope only after the Manager has disposed its instance. */
  release(scope: EventScope): void {
    if (scope.active || scope.references)
      throw new Error(`Event scope ${scope.bindingId} is still in use`);
    if (this.slots.get(scope.bindingId) === scope)
      this.slots.set(scope.bindingId, undefined);
    this.scopes.delete(scope);
    scope.closed = true;
    scope.subscriptions.clear();
  }

  private install(): void {
    for (const scope of this.scopes)
      for (const dispose of scope.disposers.splice(0)) dispose();
    for (const scope of this.slots.values()) {
      if (!scope?.active) continue;
      for (const subscription of scope.subscriptions)
        scope.disposers.push(subscription.install());
    }
  }

  private subscribe<Name extends keyof Events>(
    scope: EventScope,
    name: Name,
    handler: (
      this: ThisParameterType<Events[Name]>,
      ...args: [...Parameters<Events[Name]>, RuntimeContext]
    ) => ReturnType<Events[Name]>,
  ): () => boolean {
    if (!this.accepting || scope.closed)
      throw new Error('Plugin event scope is closed');
    if (typeof handler !== 'function')
      throw new Error(`Event listener ${String(name)} must be a function`);
    const service = this;
    // Cordis owns the event arguments and `this`; append only the execution scope.
    const listener = function (
      this: unknown,
      ...args: Parameters<Events[Name]>
    ) {
      const listenerId = `listener-${service.executionId}-${++service.sequence}`;
      const context = service.options
        .context(scope.bindingId, listenerId, scope.signal)
        .extend({ event: scope.event });
      const release = service.retain(scope);
      try {
        const result = Reflect.apply(handler, this, [...args, context]);
        if (isPromise(result)) {
          Promise.resolve(result).then(release, (error: unknown) => {
            if (ordinaryNotifications.has(name))
              service.report({
                eventName: name,
                bindingId: scope.bindingId,
                listenerId,
                error,
              });
            release();
          });
        } else release();
        return result;
      } catch (error) {
        release();
        throw error;
      }
    } as Events[Name];
    const subscription = {
      name,
      install: () => scope.context.on(name, listener),
    };
    scope.subscriptions.add(subscription);
    if (scope.active) this.install();
    return () => {
      const removed = scope.subscriptions.delete(subscription);
      if (removed && scope.active) this.install();
      return removed;
    };
  }

  private dispatch(mode: DispatchMode, args: unknown[]): unknown {
    if (!this.accepting)
      throw new Error('Experiment event admission is closed');
    const name =
      typeof args[0] === 'object' || typeof args[0] === 'function'
        ? args[1]
        : args[0];
    // Retain every potentially selected instance before Cordis snapshots its
    // callbacks, including serial/waterfall callbacks not yet entered. Native
    // context filtering still runs exactly once inside Cordis.
    const releases = [...this.slots.values()]
      .filter(
        (scope): scope is EventScope =>
          !!scope &&
          scope.active &&
          typeof name === 'string' &&
          [...scope.subscriptions].some((entry) => entry.name === name),
      )
      .map((scope) => this.retain(scope));
    const release = () => releases.forEach((dispose) => dispose());
    try {
      const result: unknown = Reflect.apply(
        this.context[mode],
        this.context,
        args,
      );
      if (isPromise(result)) Promise.resolve(result).then(release, release);
      else release();
      return result;
    } catch (error) {
      release();
      throw error;
    }
  }

  private retain(scope: EventScope): () => void {
    scope.references++;
    this.references++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      scope.references--;
      this.references--;
      if (!scope.references) {
        for (const resolve of scope.waiters) resolve();
        scope.waiters.clear();
      }
      if (!this.references) {
        for (const resolve of this.waiters) resolve();
        this.waiters.clear();
      }
    };
  }

  private report(info: EventDiagnostic): void {
    // Diagnosis must never replace an original listener result or leave an
    // unhandled rejection if persisting diagnostics itself fails.
    try {
      const result = this.options.diagnostic(info);
      if (isPromise(result)) void Promise.resolve(result).catch(() => {});
    } catch {
      // The Manager owns storage errors; event ownership must still release.
    }
  }

  get pending(): number {
    return this.references;
  }

  idle(scope?: EventScope): Promise<void> {
    const count = scope ? scope.references : this.references;
    if (!count) return Promise.resolve();
    return new Promise((resolve) =>
      (scope?.waiters ?? this.waiters).add(resolve),
    );
  }

  abort(scope: EventScope | undefined, reason?: unknown): void {
    if (scope) scope.controller.abort(reason);
    else for (const entry of this.scopes) entry.controller.abort(reason);
  }

  stop(): void {
    this.accepting = false;
    for (const scope of this.scopes) {
      scope.active = false;
      scope.closed = true;
      for (const dispose of scope.disposers.splice(0)) dispose();
    }
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.idle();
    await this.context.fiber.dispose();
    this.slots.clear();
    this.scopes.clear();
  }
}
