# Runtime events guide

English | [简体中文](../zh-CN/runtime-events.md) · [User guide](guide.md) · [Reflection](reflection.md)

Plugins access events through `RuntimeContext.event`: subscribe in `create(config, ctx)` and publish events or call services in `execute(input, ctx)` or a listener callback.

Import `RuntimeContext` from `ember-rsi/contracts`.

## 1. Built-in events

The framework publishes built-in events at the execution points below. Plugins subscribe to them directly.

| Event                           | Publication point                                                                                                  | Dispatch    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------- |
| `rsi/before-experiment`         | Before Application initialization or resumed execution.                                                            | `serial`    |
| `rsi/experiment-started`        | After the `running` record is saved, before the root Policy executes.                                              | `emit`      |
| `rsi/experiment-finished`       | After new business calls are closed and the terminal experiment record is saved.                                   | `parallel`  |
| `rsi/before-call`               | After input/budget checks and persistence of the running receipt, before the plugin call.                          | `waterfall` |
| `rsi/call-succeeded`            | After output validation and persistence of the successful receipt, before returning the result.                    | `parallel`  |
| `rsi/call-failed`               | After the failure receipt is saved, before reporting the original call error.                                      | `parallel`  |
| `rsi/call-cancelled`            | After the cancellation receipt is saved, before reporting cancellation.                                            | `parallel`  |
| `rsi/call-unknown`              | After a receipt is saved for a call whose outcome is unconfirmed.                                                  | `parallel`  |
| `rsi/policy-started`            | After input, configuration and recovery identity checks, before the first Policy step.                             | `serial`    |
| `rsi/policy-step-completed`     | After a newly executed Policy step's checkpoint is saved.                                                          | `emit`      |
| `rsi/policy-boundary-completed` | At a loop/Policy boundary, after checkpoint persistence.                                                           | `serial`    |
| `rsi/policy-completed`          | After final Policy output validation.                                                                              | `emit`      |
| `rsi/candidate-recorded`        | After the candidate is saved.                                                                                      | `emit`      |
| `rsi/measurement-recorded`      | After the measurement is validated and saved.                                                                      | `emit`      |
| `rsi/revision-activated`        | After activation persistence, effective binding updates, and subscription switching for existing plugin instances. | `emit`      |

The dispatch modes have different effects:

- `emit`: the publisher does not await asynchronous listeners. For the ordinary notifications above, listener failures are recorded as diagnostics and do not roll back saved facts; a synchronous throw can stop subsequent listeners.
- `parallel`: waits for listeners. A failing `rsi/call-succeeded` listener can fail subsequent flow while leaving the successful receipt intact. Listener errors for the other call outcomes and terminal experiment notification are diagnostic only.
- `serial`: waits for listeners in sequence. The three `serial` events in the table accept only `undefined` or `Promise<undefined>` returns. A throw prevents subsequent flow.
- `waterfall`: `rsi/before-call` listeners form an admission chain. The Manager uses its final decision to admit or reject the call.

Event payloads carry identity and necessary references. Common fields are listed below; see the [event contract](../../../src/contracts/runtime/events.ts) for exact types and field availability per event.

| Fields                                       | Meaning                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `experimentId`, `recipeId`                   | Experiment and Recipe identity; all three experiment events include `recipeId` from `recipe.id`. |
| `resumed`                                    | Whether execution resumes saved state.                                                           |
| `callId`, `parentCallId`, `path`             | Observed call, parent call, and execution position.                                              |
| `bindingId`, `bindingRef`, `revisionRef`     | Binding name, selected plugin, and revision used by the call.                                    |
| `policyId`, `policyScopeId`, `checkpointRef` | Policy definition, logical execution identity, and checkpoint reference.                         |
| `stepPath`                                   | Policy step or iteration-boundary position; steps have no fixed lifecycle-stage label.           |
| `candidateRef`, `measurementRef`             | Saved candidate/measurement references; `measurementRef` is optional on call-success events.     |

## 2. Subscribe to built-in events

Register listeners in the plugin's `create(config, factoryCtx)`. This example observes measurements from the binding named `evaluator`:

```ts
factoryCtx.event.on('rsi/call-succeeded', async (event, ctx) => {
  if (event.bindingId !== 'evaluator') return;
  if (event.measurementRef === undefined) return;

  const measurement = await ctx.readMeasurement(event.measurementRef);
  console.log(event.callId, measurement);
});
```

Replace `evaluator` with the actual binding name, not the implementation selected by `plugin`. `event.callId` identifies the observed call; `ctx.callId` identifies this listener execution.

Both `factoryCtx` and `ctx` are `RuntimeContext` instances, but represent different execution stages. Distinct variable names avoid shadowing the outer context.

To reject a call, listen to the admission event:

```ts
factoryCtx.event.on('rsi/before-call', async (event, next) => {
  if (event.bindingId === 'blockedBinding') {
    return { kind: 'reject', reason: 'This binding is disabled.' };
  }
  return next();
});
```

`next()` continues the listener chain; the default result is `{ kind: 'proceed' }`. The Manager consumes the final decision. A final `reject` requires a nonempty reason and prevents the target call. The listener context is the third argument when needed: `(event, next, ctx)`.

## 3. Declare and publish custom events

Extend Cordis `Events` in a plugin event-types module using your own namespace. This example specifies that publishers use `parallel` to await listeners:

```ts
import type {} from '@deepseek-ai/cordis';

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** @mode parallel Await observers after a proposal result is ready. */
    'demo/proposal-ready'(event: {
      experimentId: string;
      candidateRef: string;
    }): void | Promise<void>;
  }
}
```

Include this module in both publishers' and listeners' TypeScript compilation.

Subscribe in `create(config, factoryCtx)`:

```ts
factoryCtx.event.on('demo/proposal-ready', (event) => {
  console.log(event.candidateRef);
});
```

Publish in `execute(input, ctx)` after preparing the candidate, using its actual reference:

```ts
await ctx.event.parallel('demo/proposal-ready', {
  experimentId: ctx.experimentId,
  candidateRef,
});
```

Activated instances within the same experiment can subscribe. Custom events choose `emit`, `parallel`, `serial`, `bail`, or `waterfall` by their own contract; document the arguments and return types.

## 4. Trigger built-in events through business calls

In `execute` or a listener, call public services through the current execution context. Prepare the inputs for the actual business operation:

```ts
const result = await ctx.invoke('evaluator', evaluationInput);
const candidateRef = await ctx.recordCandidate(artifactRef, parentCandidateRef);
```

For the first line, the Manager publishes `rsi/before-call` before execution and the appropriate result event after saving its receipt. The second line saves a candidate and then publishes `rsi/candidate-recorded`. Application lifecycle actions also use generic call events.

## 5. Lifecycle and recovery

- **Instances receive events only after activation.** Registering a definition or configuring a binding does not start listeners. Instances are created on demand and receive no historical replay; a late-created plugin will miss experiment-start notifications.
- **Filter by source.** Business calls initiated from listeners also generate events. Filter by binding or other identity to avoid recursive self-triggering.
- **Terminal listeners perform cleanup only.** In `rsi/experiment-finished`, read records, flush logs, or release local resources; do not start new controlled business calls.
- **Recovery does not replay completed notifications.** Reusing successful receipts, restoring completed steps, or reading existing facts does not replay their events. Repeated idempotent writes may still emit record notifications.
- **The Runtime cleans up subscriptions.** Plugins must release their own files, connections, and other resources in `dispose()`.
