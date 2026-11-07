# Runtime events guide

English | [简体中文](runtime-events_zh.md) · [Getting started](../getting-started.md) · [Reflection](reflection.md)

This guide explains how to subscribe to built-in events, publish custom events, and manage listeners and cleanup across a plugin's lifecycle.

**Plugins access events through `RuntimeContext.event`: subscribe in `create(config, ctx)` and publish events or call services in `execute(input, ctx)` or a listener callback.**

## 1. Four dispatch modes

| Mode        | Meaning                                                                                                              | Example                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `emit`      | Continue after publishing without waiting for asynchronous listeners.                                                | `rsi/candidate-recorded`: notify plugins to update statistics after a candidate is saved.                |
| `parallel`  | Run listeners concurrently and wait for asynchronous listeners to finish.                                            | `rsi/experiment-finished`: wait for listeners to flush logs and release local resources.                 |
| `serial`    | Run listeners in order, waiting for each to finish before starting the next; a throw prevents subsequent flow.       | `rsi/before-experiment`: run checks in order before the experiment starts.                               |
| `waterfall` | Process admission decisions through a listener chain; the Manager uses the final result to admit or reject the call. | `rsi/before-call`: decide whether to allow a binding's call, returning a `proceed` or `reject` decision. |

- Listeners for built-in `serial` events must return only `undefined` or `Promise<undefined>`. Returning values such as `true`, `0`, a string, or an object ends that event dispatch early and skips subsequent listeners.

## 2. Built-in events

The framework publishes built-in events at the execution points below. Plugins subscribe to them directly. The tables document every field of the listener's first argument, `event`: each event contains its group's common parameters plus the event-specific parameters listed in its row. Fields are required unless marked with `?`; `?` means a field may be omitted, while `string | null` means the field is present but may hold `null`. All fields are read-only; see the [event contract](../../../src/contracts/runtime/events.ts) for the type definitions.

Ordinary listeners receive `(event, ctx)`; `rsi/before-call` listeners receive `(event, next, ctx)`. `ctx` is the current listener's `RuntimeContext`; `next: () => Promise<CallDecision>` continues subsequent listeners and returns the admission decision, as described in [Subscribe to built-in events](#3-subscribe-to-built-in-events). Neither `ctx` nor `next` is a field of `event`.

### Experiment lifecycle

**Common parameters:**

| Field          | Type     | Meaning                            |
| -------------- | -------- | ---------------------------------- |
| `experimentId` | `string` | ID of the experiment.              |
| `recipeId`     | `string` | Recipe ID, taken from `recipe.id`. |

**Events and event-specific parameters:**

| Event                     | Publication point                                                                | Dispatch   | Event-specific parameters                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `rsi/before-experiment`   | Before Application initialization or resumed execution.                          | `serial`   | `policyId: string`: ID of the Policy to execute.<br>`resumed: boolean`: Whether this run resumes an existing experiment.     |
| `rsi/experiment-started`  | After the `running` record is saved, before the root Policy executes.            | `emit`     | `policyId: string`: ID of the Policy being executed.<br>`resumed: boolean`: Whether this run resumes an existing experiment. |
| `rsi/experiment-finished` | After new business calls are closed and the terminal experiment record is saved. | `parallel` | `status: 'succeeded' \| 'failed' \| 'cancelled'`: Final experiment status: success, failure, or cancellation.                |

### Plugin calls

**Common parameters:**

| Field          | Type                                                               | Meaning                                                                                                               |
| -------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `experimentId` | `string`                                                           | ID of the experiment.                                                                                                 |
| `callId`       | `string`                                                           | ID of the observed plugin call.                                                                                       |
| `bindingId`    | `string`                                                           | Name of the invoked binding, such as `evaluator`.                                                                     |
| `parentCallId` | `string`                                                           | ID of the parent execution that initiated this call.                                                                  |
| `path`         | `string`                                                           | Position of the call in the flow; usually a step path for Policy calls, or the caller's execution ID for other calls. |
| `bindingRef`   | `string`                                                           | Plugin ID selected by the binding, such as `evaluator.agentbench`.                                                    |
| `revisionRef`  | `string \| null`                                                   | Plugin revision used by this call, or `null` when no revision is active.                                              |
| `status`       | `'running' \| 'succeeded' \| 'failed' \| 'cancelled' \| 'unknown'` | State of this call; `before-call` uses `running`, while the other events use the state in their names.                |

**Events and event-specific parameters:**

| Event                | Publication point                                                                               | Dispatch    | Event-specific parameters                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| `rsi/before-call`    | After input/budget checks and persistence of the running receipt, before the plugin call.       | `waterfall` | None.                                                                                                             |
| `rsi/call-succeeded` | After output validation and persistence of the successful receipt, before returning the result. | `parallel`  | `measurementRef?: string`: Optional. Present only when the call's output object contains a measurement reference. |
| `rsi/call-failed`    | After the failure receipt is saved, before reporting the original call error.                   | `parallel`  | None.                                                                                                             |
| `rsi/call-cancelled` | After the cancellation receipt is saved, before reporting cancellation.                         | `parallel`  | None.                                                                                                             |
| `rsi/call-unknown`   | After a receipt is saved for a call whose outcome is unconfirmed.                               | `parallel`  | None.                                                                                                             |

### Policy execution

**Common parameters:**

| Field           | Type     | Meaning                                                                    |
| --------------- | -------- | -------------------------------------------------------------------------- |
| `experimentId`  | `string` | ID of the experiment.                                                      |
| `policyId`      | `string` | ID of the executing Policy.                                                |
| `policyScopeId` | `string` | Logical execution scope of the Policy; currently `root` for the root flow. |
| `checkpointRef` | `string` | Reference to the Policy's checkpoint record.                               |

**Events and event-specific parameters:**

| Event                           | Publication point                                                                      | Dispatch | Event-specific parameters                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rsi/policy-started`            | After input, configuration and recovery identity checks, before the first Policy step. | `serial` | `resumed: boolean`: Whether execution resumes a saved Policy checkpoint.                                                                                                                                                                                                                                                                    |
| `rsi/policy-step-completed`     | After a newly executed Policy step's checkpoint is saved.                              | `emit`   | `stepPath: string`: Full path of the completed step, such as `steps/evaluate`.                                                                                                                                                                                                                                                              |
| `rsi/policy-boundary-completed` | At a loop/Policy boundary, after checkpoint persistence.                               | `serial` | `boundary: 'iteration-completed' \| 'policy-completed'`: Identifies a completed loop iteration or completed Policy execution.<br>`iteration?: number`: Optional. Zero-based iteration index, present only at a loop-iteration boundary.<br>`stepPath?: string`: Optional. Path of the loop step, present only at a loop-iteration boundary. |
| `rsi/policy-completed`          | After final Policy output validation.                                                  | `emit`   | None; common parameters only.                                                                                                                                                                                                                                                                                                               |

### Candidates, measurements, and revisions

**Common parameters:**

| Field          | Type     | Meaning               |
| -------------- | -------- | --------------------- |
| `experimentId` | `string` | ID of the experiment. |

**Events and event-specific parameters:**

| Event                      | Publication point                                                                                                  | Dispatch | Event-specific parameters                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rsi/candidate-recorded`   | After the candidate is saved.                                                                                      | `emit`   | `callId: string`: ID of the call that recorded this data.<br>`bindingId: string`: Name of the binding that recorded this data.<br>`candidateRef: string`: Reference to the saved candidate.<br>`parentRef: string \| null`: Parent candidate reference, or `null` for an initial candidate.                                                                                                                        |
| `rsi/measurement-recorded` | After the measurement is validated and saved.                                                                      | `emit`   | `callId: string`: ID of the call that recorded this data.<br>`bindingId: string`: Name of the binding that recorded this data.<br>`measurementRef: string`: Reference to the saved measurement.                                                                                                                                                                                                                    |
| `rsi/revision-activated`   | After activation persistence, effective binding updates, and subscription switching for existing plugin instances. | `emit`   | `activationId: string`: ID of this revision activation record.<br>`bindingIds: readonly string[]`: Names of the bindings affected by this activation.<br>`revisionRefs: Readonly<Record<string, string>>`: Map of revisions activated in this operation, keyed by binding name.<br>`policyRevisionRef?: string`: Optional Policy revision reference reserved by the contract; the current Runtime does not set it. |

## 3. Subscribe to built-in events

Register listeners in the plugin's `create(config, factoryCtx)`. This example observes measurements from the binding named `evaluator`:

```ts
factoryCtx.event.on('rsi/call-succeeded', async (event, ctx) => {
  if (event.bindingId !== 'evaluator') return;
  if (event.measurementRef === undefined) return;

  const measurement = await ctx.readMeasurement(event.measurementRef);
  console.log(event.callId, measurement);
});
```

- Replace `evaluator` with the actual binding name, not the implementation selected by `plugin`. `event.callId` identifies the observed call; `ctx.callId` identifies this listener execution.

- Both `factoryCtx` and `ctx` are `RuntimeContext` instances, but represent different execution stages. Distinct variable names avoid shadowing the outer context.

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

## 4. Declare, subscribe to, and publish custom events

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

- Include this module in both publishers' and listeners' TypeScript compilation.

Subscribe in `create(config, factoryCtx)`:

```ts
factoryCtx.event.on('demo/proposal-ready', (event) => {
  console.log(event.candidateRef);
});
```

Publish in `execute(input, ctx)` after preparing the candidate:

```ts
await ctx.event.parallel('demo/proposal-ready', {
  experimentId: ctx.experimentId,
  candidateRef,
});
```

Activated instances within the same experiment can subscribe. Custom events choose `emit`, `parallel`, `serial`, `bail`, or `waterfall` by their own contract; document the arguments and return types.

## 5. Trigger built-in events through business calls

**When a plugin calls a Runtime service, Runtime automatically publishes the corresponding built-in events.** The following are two independent examples:

```ts
// 1. Calling the evaluator binding triggers rsi/before-call before execution.
// After saving the result, Runtime publishes the matching success, failure, or other outcome event.
const result = await ctx.invoke('evaluator', evaluationInput);

// 2. Registering the file snapshot as a candidate triggers rsi/candidate-recorded after the candidate is saved.
const candidateRef = await ctx.recordCandidate(artifactRef, parentCandidateRef);
```

## 6. Usage notes

- **Instances receive events only after activation.** Registering a plugin definition or configuring a binding does not start listeners; for example, a plugin created later will miss experiment-start notifications.
- **Filter by source.** Business calls initiated from listeners also generate events. Filter by binding or other identity to avoid recursive self-triggering.
- **Terminal listeners perform cleanup only.** In `rsi/experiment-finished`, read records, flush logs, or release local resources; do not start new controlled business calls.
- **Recovery does not replay completed notifications.** Reusing successful receipts, restoring completed steps, or reading existing facts does not replay their events.
- **The Runtime cleans up subscriptions.** Plugins must release their own files, connections, and other resources in `dispose()`.
