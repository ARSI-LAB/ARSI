# Public plugin services

Use `context` supplied to `execute(input, context)` for experiment-scoped calls. `create(config, services)` receives host services but does not establish an active experiment. Do not call recordCandidate on `runtime.context` outside Manager execution, manually forge a scope, or destructure methods that require `this`.

| Call                                                                | Result / ownership                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `artifacts.putJson(value)`                                          | `Promise<string>` content ref                                                   |
| `artifacts.readJson(ref)`                                           | `Promise<JsonValue>`                                                            |
| `artifacts.capture(directory)`                                      | File-tree artifact ref                                                          |
| `artifacts.materialize(ref, directory)`                             | Restores a file tree into a new/empty real directory; no merge/overwrite        |
| `readCandidate(ref)`                                                | `{ ref, artifactRef, parentRef, experimentId }`                                 |
| `recordCandidate(artifactRef, parentRef)`                           | Candidate **ref string**; parent is string or null, not an object argument      |
| `workspaces.create(artifactRef?, parentCandidateRef?)`              | `{ ref, directory, parentCandidateRef }`; release in finally                    |
| `workspaces.read(ref)` / `release(ref)`                             | Workspace lookup / cleanup                                                      |
| `application(input)`                                                | Controlled Application lifecycle call                                           |
| `applicationMetadata()`                                             | Current target, capabilities and initial candidate identity                     |
| `withInstance(candidateRef, capability, async execution => result)` | Owns acquire/release around callback; use `execution.directory` for AgentBundle |
| `recordMeasurement(measurement)`                                    | Measurement ref string; validates ownership and all referenced structures       |
| `readMeasurement(ref)`                                              | Owned Measurement JSON                                                          |
| `readEvidence(refs, { view?, maxBytes?, format?: 'files' })`        | Authorized bounded evidence JSON                                                |
| `invoke(bindingKey, input)`                                         | Controlled validated dependency call                                            |
| `invokeAgent(agentRef, input)`                                      | Selects the Recipe binding by `agentRef` and sends `input` to the Agent         |
| `charge(metric, amount)`                                            | Charges actual nonnegative usage; e.g. evaluator `evaluationRuns`               |

Execution context also supplies `experimentId`, `callId`, `bindingId`, `idempotencyKey`, `signal` and `cleanup`. Propagate signal into external requests. The owner of an external effect must bound it and reconcile uncertain outcomes before retrying. `dispose()` releases plugin-owned resources; Runtime disposal is required even on error.

## Candidate commit

A custom Application initializes with `const artifactRef = await context.artifacts.capture(baselineDirectory); const ref = await context.recordCandidate(artifactRef, null);` and returns `{ action: 'initialize', initialCandidateRef: ref, target, capabilities }`. That custom Application owns target validation. Do not use this shortcut in a proposer to bypass the chosen Application's target checks.

The complete [proposer](../assets/minimal/extension/operations.mjs) demonstrates the regular edit flow: read parent → `workspaces.create(parent.artifactRef, input.parent)` → write permitted files → `application({ action: 'commit', parentCandidateRef, editRef: workspace.ref })` → release workspace in finally. `editRef` is a workspace reference, not an artifact reference or path. Preserve `created` vs `no-change` and nullable diffRef.

Application contract actions are initialize, commit, acquire (`candidateRef`, `instanceId`, `capability`) and release (`instanceId`). Acquire returns `execution`; release returns `{ action: 'release', instanceId, status: 'released' }`. Prefer `withInstance` in evaluators to manual lease management.

## Measurement and evidence

Use the complete public-only [evaluator implementation](../assets/minimal/extension/operations.mjs) as the minimal legal example. Import `typedArtifact`, validation helpers and measurement schemas from `ember-rsi/contracts`, not private subpaths.

A Measurement is not `{ score }`. Supply `schemaVersion: rsi.measurement/v1`, current experiment/call IDs, candidateRef, evaluator `{ pluginId, implementationDigest }`, timestamps, status, coverage, comparisonKey, typed conditions/provenance/profile, metric map, itemsRef, evidenceIndexRef, diagnosticsRef and extensions. Manager creates `ref`; do not manufacture one. Every referenced artifact must exist. `typedArtifact(schemaId, schema, ref)` computes the descriptor's schema digest; it does not validate payload contents for you.

Keep `measurement.evaluator.pluginId` aligned with the registered evaluator implementation ID, not the Recipe binding key. When copying or renaming an evaluator, update its registration and emitted metadata together; an old unregistered ID can fail during measurement recording even when the plugin itself executes. The starter defines `evaluatorId` once for both locations. Spreading a definition and overriding only its `id` does not rewrite IDs captured by its implementation.

Each available metric has definitionRef, status, a scalar/distribution value and source `{ artifactRef, pointer }`. Definition specifies id, description, unit, valueKind, version 1, aggregation and mapping. Unavailable metrics retain null value and reason. Items use `rsi.measurement-items/v1`; evidence uses `rsi.measurement-evidence/v1` with entries specifying access (`execution`, `delivery`, `private`) and integrity. Never expose private verifier material as execution evidence.

Status governs whether a value may be compared. Keep unavailable, failed and unknown-coverage results out of the pools used to sample a winner or admit a candidate, and preserve their original meaning when reporting; never coerce them to zero. A measured scalar `0` is an observed value and may legitimately win or be admitted. An unavailable baseline or initial evaluation leaves no admission threshold rather than a zero one, so require a successful measurement before treating a candidate as an improvement over it.

The stock metric selector requires successful, complete, comparable measurements with equal nonempty comparisonKey and matching metric definitions. Scalar values need no statistic; distributions require one. Ties retain incumbent. Preserve the chosen candidate and measurement together.

`facts.read(kind,id)` and `facts.list(kind)` are useful for scoped inspection; filter by experimentId when listing. Do not use `facts.write` to bypass Manager candidate/measurement/receipt ownership.
