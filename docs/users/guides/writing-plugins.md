# Write a plugin

English | [简体中文](writing-plugins_zh.md) · [Getting started](../getting-started.md)

This guide explains how to choose plugin contracts, understand their fields, implement and register plugins, and connect them to Runtime through Recipes and Policies.

Plugins provide business capabilities, Policies decide when to call them, and Recipes select implementations and supply configuration. For flow fields, see [Write a Policy](writing-policies.md); for built-in implementation settings, see [Configuration](configuration.md) and [Built-in components](built-in-components.md).

## Choose the extension boundary

| Need                                                                               | Extension                                                                                                           |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Change tasks, limits, model, or existing prompt paths                              | Override the corresponding Recipe configuration or binding.                                                         |
| Replace inference/tool execution while reusing Proposer evidence and edit handling | Implement `contract.agent` and replace the Agent binding being called.                                              |
| Replace the complete proposal workflow                                             | Implement `contract.proposer`.                                                                                      |
| Manage a new optimization target, candidate commits, or execution instances        | Implement `contract.application`.                                                                                   |
| Add an evaluation method                                                           | Implement `contract.agentbench`, `contract.inferencebench`, or `contract.operatorbench`, as required by the caller. |
| Change candidate selection, experience consolidation, or plugin self-evolution     | Implement the corresponding Selector, Memory, or Reflection contract.                                               |
| Add a parameter search algorithm                                                   | Implement `contract.proposer-grid` or `contract.proposer-parameter-search`.                                         |
| Change orchestration, state, or stopping rules                                     | Register a custom Policy.                                                                                           |

### Distinguish contracts, implementations, bindings, and steps

| Name                     | Example                | Where it belongs                                                   |
| ------------------------ | ---------------------- | ------------------------------------------------------------------ |
| Contract ID              | `contract.proposer`    | Policy `require.proposer.contract`; defines input and output.      |
| Plugin implementation ID | `proposer.keep-parent` | Plugin definition `id` and binding declaration `plugin`.           |
| Binding name             | `proposer`             | `require`, `defaults.bindings`, Recipe `bindings`, and step `use`. |
| Step ID                  | `propose`              | Step `id`; read its result through `steps.propose.output`.         |
| Policy ID                | `policy.my-search`     | Policy `id`, registration ID, and Recipe `policy.id`.              |

Binding names are declared by the Policy, not drawn from a fixed role enum. For example, `domainProposer` and `skillProposer` can both require `contract.proposer` and bind different implementations. A regular plugin implements one public contract; multiple lifecycle actions share one `execute` with an `action` union. A Policy is a separate flow definition, not a plugin binding, and there are no child Policy bindings.

## Choose a public contract

Choose the contract required by the caller and reuse its exported object and types. The contract owns `id`, `input_schema`, and `output_schema`; the plugin owns its configuration Schema. Even when TypeScript types appear compatible, Runtime checks the contract ID and Schema identity.

| Contract and field definitions                                                                         | Exported contract object          | Input / output types                               |
| ------------------------------------------------------------------------------------------------------ | --------------------------------- | -------------------------------------------------- |
| [contract.application](../../../src/contracts/plugin-types/application.ts)                             | `applicationContract`             | `ApplicationInput` / `ApplicationOutput`           |
| [contract.agent](../../../src/contracts/plugin-types/agent.ts)                                         | `agentContract`                   | `AgentInput` / `AgentOutput`                       |
| [contract.proposer](../../../src/contracts/plugin-types/proposer.ts)                                   | `proposerContract`                | `ProposerInput` / `ProposerOutput`                 |
| [contract.proposer-operator](../../../src/contracts/plugin-types/proposer-operator.ts)                 | `operatorProposerContract`        | `OperatorProposerInput` / `OperatorProposerOutput` |
| [contract.agentbench](../../../src/contracts/plugin-types/agentbench.ts)                               | `agentbenchContract`              | `AgentbenchInput` / `AgentbenchOutput`             |
| [contract.inferencebench](../../../src/contracts/plugin-types/inferencebench.ts)                       | `inferencebenchContract`          | `InferencebenchInput` / `InferencebenchOutput`     |
| [contract.operatorbench](../../../src/contracts/plugin-types/operatorbench.ts)                         | `operatorbenchContract`           | `OperatorbenchInput` / `OperatorbenchOutput`       |
| [contract.selector-metrics](../../../src/contracts/plugin-types/selector-metrics.ts)                   | `metricSelectorContract`          | `MetricSelectorInput` / `MetricSelectorOutput`     |
| [contract.selector-artifacts](../../../src/contracts/plugin-types/selector-artifacts.ts)               | `artifactSelectorContract`        | `ArtifactSelectorInput` / `ArtifactSelectorOutput` |
| [contract.memory](../../../src/contracts/plugin-types/memory.ts)                                       | `memoryContract`                  | `MemoryInput` / `MemoryOutput`                     |
| [contract.reflection](../../../src/contracts/plugin-types/reflection.ts)                               | `reflectionContract`              | `ReflectionInput` / `ReflectionOutput`             |
| [contract.proposer-grid](../../../src/contracts/plugin-types/proposer-grid.ts)                         | `gridProposerContract`            | `GridProposerInput` / `GridProposerOutput`         |
| [contract.proposer-parameter-search](../../../src/contracts/plugin-types/proposer-parameter-search.ts) | `parameterSearchProposerContract` | `ParameterSearchInput` / `ParameterSearchOutput`   |

The fields below follow the current public contracts. Fields are required unless marked optional; optional does not imply nullable. Use Runtime-returned values for references such as `candidateRef` and `measurementRef`, not local file paths.

### Application: targets and instance lifecycles

Input and output carry the same `action`. A `capability` is a name advertised by the Application, such as `agentbundle`, not a plugin ID. The Application and consuming Evaluator agree on the concrete `execution` object.

| `action`     | Other input fields                                                  | Other output fields                                                               |
| ------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `initialize` | None.                                                               | `initialCandidateRef`, `target` object, and `capabilities` string array.          |
| `commit`     | `parentCandidateRef`, `editRef`; optional `editConstraints` object. | `status: created \| no-change`, `candidateRef`, and `diffRef` (string or `null`). |
| `acquire`    | `candidateRef`, `instanceId`, `capability`.                         | `instanceId`, `execution` object.                                                 |
| `release`    | `instanceId`.                                                       | `instanceId`, `status: released`.                                                 |

The Application validates target scope, seals candidates, and acquires/releases instances. Evaluators consume instances through `context.withInstance()`. Initialization's `initialCandidateRef` maps to `application.initialCandidate` in Policy expressions; `context.applicationMetadata()` retains the `initialCandidateRef` name.

### Agent: inference and tool execution

| Input field     | Required | Type and meaning                                                                              |
| --------------- | -------- | --------------------------------------------------------------------------------------------- |
| `goal`          | Yes      | String describing this call's goal.                                                           |
| `prompt`        | Yes      | String containing the prompt for this call.                                                   |
| `outputSchema`  | Yes      | Object describing the Schema the returned JSON object must satisfy.                           |
| `input`         | No       | Any JSON value containing additional business input.                                          |
| `files`         | No       | Map of filenames to string content, representing virtual files.                               |
| `agentRef`      | No       | Agent binding name. `invokeAgent()` defaults to `agent.default`.                              |
| `maxModelCalls` | No       | Integer of at least 1 limiting actual model request attempts when supported by the transport. |

The return value is a JSON object. The public contract's `output_schema` only checks that it is an object; a custom backend must also validate the requested `input.outputSchema`. Document the backend's tools and execution permissions, propagate cancellation, and release processes, sessions, and other resources. `files` does not itself grant host filesystem access.

Backends that own the model transport charge actual request attempts with `context.charge('modelCalls', 1)`, including retries and output corrections. A backend without an authoritative attempt counter, such as native Codex, must declare that usage unavailable, must not record missing counts as zero, and cannot claim to enforce model-call budgets. Built-in backend configuration fields are covered in [Agent configuration](configuration.md#agent-and-environment-variables).

### Proposer: producing candidates

| Input field       | Required | Type and meaning                                                                                                 |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `parent`          | Yes      | Parent candidate reference.                                                                                      |
| `goal`            | Yes      | Nonempty string describing the editing goal.                                                                     |
| `evidenceRefs`    | Yes      | Array of nonempty reference strings; the array may be empty.                                                     |
| `sources`         | No       | Array of `{ candidateRef, measurementRef? }` providing reference candidates and measurements.                    |
| `memoryRef`       | No       | Memory reference or `null`.                                                                                      |
| `editConstraints` | No       | Object containing per-call editing limits, interpreted and enforced by the implementation at the write boundary. |

Output must have one of these two shapes, both including a `rationale` string:

| `status`    | Other output fields                              |
| ----------- | ------------------------------------------------ |
| `created`   | `candidateRef`, nonempty `diffRef`, `rationale`. |
| `no-change` | `candidateRef`, `diffRef: null`, `rationale`.    |

For file edits, modify a workspace, submit the candidate through the Application's `commit`, and release the workspace in `finally`. See the [skill's deterministic Proposer](../../../skills/ember-rsi/assets/minimal/extension/operations.mjs). The built-in Agent Proposer's model editing protocol is defined in [shared editing code](../../../src/plugins/shared/agent-editing/index.ts); a replacement Agent must still satisfy the caller's requested output Schema.

### Evaluation, selection, Memory, and Reflection

| Contract                      | Input fields                                                                                                                                                                     | Output fields                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contract.agentbench`         | `candidateRef`, `taskIds` (nonempty array of unique nonempty strings).                                                                                                           | `measurementRef`.                                                                                                                                                                                                                                                                                                                          |
| `contract.inferencebench`     | `candidateRef`.                                                                                                                                                                  | `measurementRef`.                                                                                                                                                                                                                                                                                                                          |
| `contract.selector-metrics`   | `incumbentMeasurementRef`, `candidateMeasurementRef`.                                                                                                                            | `accepted`, `candidateFeasible`, `selectedCandidateRef`, `measurementRef`, `decisionRef`, `reason`, `metric`, `incumbentValue`, `candidateValue`, `selectedValue`. The first two are booleans; `incumbentValue` and `selectedValue` are numbers, while `candidateValue` is a number or `null` when the candidate fails eligibility checks. |
| `contract.selector-artifacts` | Nonempty `candidates` array of `{ candidateRef, measurementRef }`; nonempty `rubric` string.                                                                                     | `candidateRef`, `measurementRef`, `decisionRef`.                                                                                                                                                                                                                                                                                           |
| `contract.memory`             | `memoryRef` (reference or `null`), `goal`, `evidenceRefs`; optional `editConstraints`, `comparison`, `observations` (object or `null`), `sources` (array of `{ candidateRef }`). | For `status: updated`, nonempty references `memoryRef` and `changeRef`, plus a `reason` string; for `status: no-change \| failed`, `memoryRef` (reference or `null`), `changeRef: null`, and `reason`.                                                                                                                                     |
| `contract.reflection`         | `parentRevisionRefs` (nonempty map of binding names to revision references), `resourceRef`, `goal`, `evidenceRefs`, `editConstraints`.                                           | For `status: proposed`, `proposal: { parentRevisionRefs, resourceRef, changeRef }` and `reason`; for `status: no-change`, `proposal: null` and `reason`.                                                                                                                                                                                   |

Memory's optional `comparison` contains `baselineCandidateRef`, `probes`, and `selection`. `probes` is a nonempty map whose groups are nonempty arrays of `{ candidateRef, measurementRef, slot? }`, with a nonnegative integer `slot`; `selection` contains `candidateRef`, `measurementRef`, and `decisionRef`.

Evaluators record measurements following the [public Measurement protocol](../../../src/contracts/models/measurement.ts), then return references. Measurement `status` accepts `succeeded / failed / cancelled / unknown`; `coverage` accepts `complete / partial / none / unknown`. Metric `status` accepts `available / unavailable`, and available value `kind` accepts `scalar / distribution`; unavailable metrics use `value: null` and supply a `reason`. The built-in metric selector checks configured `eligibility` conditions first, rejecting an ineligible new candidate without reading its objective metric. Measurements entering metric comparison must be successful, complete, comparable, and have matching metric definitions; distribution metrics also require an explicit statistic. See [Metric selection](configuration.md#metric-selection) for eligibility, extra constraints, and minimum improvement thresholds.

Reflection plugins use execution evidence to propose revisions to target plugins. Runtime owns evidence, structural validation, persistence, and activation; plugin `proposed` does not mean a revision is active. The step's `activated / no-change / skipped / rejected` values are Runtime outcomes. See [Reflection](reflection.md).

### Operator optimization

`policy.operator-search` uses dedicated Proposer and Evaluator contracts to orchestrate kernel changes and assessment:

| Contract and action                               | Input purpose                                                                                                                                                                          | Output                                                                                                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract.proposer-operator`, `action: propose`   | `phase: static` analyzes source using the entry candidate and baseline measurement; `phase: metrics` improves performance using the incumbent, assessment, and profiling measurements. | `status`, `candidateRef`, `diffRef`, `analysisRef`, `rationale`, and `reasonCode`; status is `created`, `no-change`, or `failed`, with `errorRef` on failure. |
| `contract.proposer-operator`, `action: repair`    | Supply the failed candidate, its measurement, and analysis references to repair that candidate.                                                                                        | The same result structure as `propose`.                                                                                                                       |
| `contract.proposer-operator`, `action: summarize` | Summarize the current phase's candidates, measurements, and selection to update history for later calls.                                                                               | `historyRef`, `summaryRef`.                                                                                                                                   |
| `contract.operatorbench`, `action: evaluate`      | `candidateRef` and `caseIds` select the candidate and cases for correctness checks and latency measurement.                                                                            | `measurementRef`.                                                                                                                                             |
| `contract.operatorbench`, `action: profile`       | Supply `assessmentMeasurementRef` alongside `candidateRef` and `caseIds` to reference the candidate's existing assessment.                                                             | `measurementRef`, `collectionStatus: completed \| unavailable`.                                                                                               |

Outputs also carry the matching `action`. The table summarizes each action's purpose; actual calls must supply goal, iteration, analysis, history, and other fields required by the corresponding `phase` / `action` branch in the [Proposer contract](../../../src/contracts/plugin-types/proposer-operator.ts). See the [Operator Search Policy](../../../src/policies/operator-search/policy.yaml) for the complete flow and the [operator optimization example](../../../examples/artifacts/kernel/transpose-copy/README.md) for run configuration.

### Parameter search

`contract.proposer-grid` accepts `parent` and a nonnegative integer `cursor`. A `status: candidate` result includes `candidateRef`, `parameters` object, `nextCursor`, and `totalCandidates`; `status: exhausted` includes only `nextCursor` and `totalCandidates`. `nextCursor` is a nonnegative integer; `totalCandidates` is a positive integer.

`contract.proposer-parameter-search` uses `action` to distinguish three actions:

| `action`     | Other input fields                                      | Other output fields                                                                                                                                               |
| ------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize` | `parent`.                                               | `stateRef`.                                                                                                                                                       |
| `suggest`    | `stateRef`.                                             | For `status: candidate`, `stateRef`, `trialId`, `candidateRef`, `parameters`; for `status: stopped`, `stateRef` and `reason: search-exhausted \| sampling-limit`. |
| `observe`    | `stateRef`, `trialId`, `measurementRef`, `decisionRef`. | New `stateRef`.                                                                                                                                                   |

Output must also carry the matching `action`. Search state is saved through references; the Policy orchestrates loops and stopping conditions. See the [Optuna Policy](../../../src/policies/parameter-optuna/policy.yaml) for a complete call sequence.

## Implement the plugin lifecycle

Organize a plugin around `schema.ts` (configuration), `service.ts` (business behavior and cleanup), and `index.ts` (definition assembly). Input/output Schemas belong only to the public contract and are not redeclared by implementations. Repository plugins import local contracts; external packages use `ember-rsi` or `ember-rsi/contracts`, not private `src/*` imports.

### Plugin definition fields

The three parameters of `OperationDefinition<I, O, C>` are contract input, contract output, and plugin configuration. Definitions accept only the following fields; see the [operation contract](../../../src/contracts/operation.ts):

| Field                  | Required | Meaning                                                                                                                                                           |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | Yes      | Unique implementation ID, such as `proposer.keep-parent`. Must not collide with a registered plugin or Policy.                                                    |
| `description`          | No       | Description of the implementation.                                                                                                                                |
| `contract`             | Yes      | An imported public contract object from the table above, not a contract ID string.                                                                                |
| `configSchema`         | Yes      | This implementation's configuration Schema; declare an object Schema even when there is no configuration.                                                         |
| `create`               | Yes      | Async `create(config, context)` factory returning a plugin instance.                                                                                              |
| `implementationDigest` | No       | Implementation fingerprint for locking and recovery identity checks. A release can supply a build-content digest; update it when behavior-affecting code changes. |

Without `implementationDigest`, Registry fingerprints the factory function text, contract, and configuration Schema. This does not automatically cover imported helper modules; supply a digest covering the actual implementation when those changes must be identified reliably.

### Instance methods and call order

| Method                                                | Required | Responsibility                                                                                                   |
| ----------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `execute(input, context): Promise<O>`                 | Yes      | Perform business work and return JSON data matching the contract.                                                |
| `dispose(): Promise<void>`                            | Yes      | Release instance-owned processes, connections, listeners, and other resources; may be empty when there are none. |
| `canRetry(input, receipt, context): Promise<boolean>` | No       | Use read-only checks to confirm that a settled failed or cancelled call can be replayed safely.                  |

Loading a Recipe only assembles definitions; it does not call `create` or `execute`. Runtime calls the factory when an instance is needed, then validates input/output, records receipts, and charges usage at call boundaries. An instance can serve multiple calls; parallel branches may call the same binding concurrently, so keep per-call data and temporary resources local to each call. Configuration revisions can create new instances, with versions and disposal managed by Runtime.

Use the factory context for instance resources and the current `execute` context for each call. Do not retain the first call's `callId`, cancellation signal, or other call-specific values for later calls. If the factory fails before returning an instance, it must release resources already created. `dispose` has no arguments; retain its instance resources in the closure.

Return `true` from `canRetry` only when replay cannot duplicate effects, for settled failed or cancelled calls. Runtime archives the original receipt and charges the retry normally. This hook does not introduce a retry loop during ordinary execution or automatically replay calls with unknown or still-running outcomes.

## Define the configuration Schema

Configuration is a JSON object. `create` receives it after merging, validation, default filling, and path resolution. The following Schema fields are useful; each plugin chooses its configuration field names and allowed values.

| Schema field                         | Values or syntax                                                                           | Purpose                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `type`                               | `object`, `array`, `string`, `integer`, `number`, `boolean`, `null`, or an array of types. | Declare a type, such as `{ type: ['string', 'null'] }`.                                          |
| `properties`                         | Map of field names to Schemas.                                                             | Describe object fields; listing a field here does not make it required.                          |
| `required`                           | Array of field names.                                                                      | Declare required fields.                                                                         |
| `additionalProperties`               | Usually `false`; may also be a Schema.                                                     | Reject misspelled or unknown fields, or constrain map values.                                    |
| `enum` / `const`                     | For example, `enum: ['maximize', 'minimize']` / `const: 'retain-incumbent'`.               | Restrict choices or require one fixed value.                                                     |
| `default`                            | JSON value matching the field type.                                                        | Fill an omitted value after configuration merging; TypeScript does not provide it automatically. |
| `minimum` / `maximum`                | Numbers.                                                                                   | Set numeric bounds; counts usually also need `type: integer`.                                    |
| `minLength` / `pattern`              | Length / regular expression string.                                                        | Constrain strings.                                                                               |
| `items` / `minItems` / `uniqueItems` | Item Schema / minimum count / boolean.                                                     | Constrain array contents, size, and uniqueness.                                                  |
| `oneOf`                              | Array of Schemas.                                                                          | Declare mutually exclusive shapes discriminated by fields such as `action`.                      |
| `x-rsi-path`                         | `file` or `directory`, on a path string's Schema.                                          | Mark file or directory paths to resolve against their declaration origins.                       |

Only explicitly marked paths are resolved. Inherited values resolve relative to the Policy file; Recipe overrides resolve relative to the Recipe file, including paths inside nested objects and arrays. A path marker does not replace existence or write-permission checks. Ordinary strings, resource references, and `${NAME}` environment references do not undergo universal path or environment substitution; each owning plugin interprets its environment references. `${{ ... }}` is used in Policy/Recipe dataflow templates.

For a concrete example, the [metric selector configuration Schema](../../../src/plugins/selector-metrics/schema.ts) accepts `maximize / minimize` for `direction`, `mean / p50 / p95 / p99` for `statistic`, and only `retain-incumbent` for `tieBreak`. These are `selector.metric` configuration fields, not public inputs shared by all Selectors.

## Write a minimal plugin

The following Proposer always retains the parent candidate. All three files are complete, and it makes no model calls. Use it to verify registration and dataflow before adding real edits using the deterministic Proposer linked above.

In a TypeScript ESM project with `ember-rsi` installed, place the files under `src/proposer-keep-parent/` and compile them to `dist/proposer-keep-parent/`. Relative imports use the built `.js` extensions.

`schema.ts`:

```ts
import type { JsonSchema } from 'ember-rsi/contracts';

export type KeepParentConfig = { reason: string };

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    reason: { type: 'string', minLength: 1 },
  },
  required: ['reason'],
  additionalProperties: false,
};
```

`service.ts`:

```ts
import type {
  Operation,
  ProposerInput,
  ProposerOutput,
  RuntimeContext,
} from 'ember-rsi/contracts';
import type { KeepParentConfig } from './schema.js';

export async function createKeepParent(
  config: KeepParentConfig,
  _context: RuntimeContext,
): Promise<Operation<ProposerInput, ProposerOutput>> {
  return {
    async execute(input, context): Promise<ProposerOutput> {
      context.signal.throwIfAborted();
      await context.readCandidate(input.parent);
      return {
        status: 'no-change',
        candidateRef: input.parent,
        diffRef: null,
        rationale: config.reason,
      };
    },
    async dispose(): Promise<void> {},
  };
}
```

`index.ts`:

```ts
import {
  proposerContract,
  type OperationDefinition,
  type ProposerInput,
  type ProposerOutput,
} from 'ember-rsi/contracts';
import { configSchema, type KeepParentConfig } from './schema.js';
import { createKeepParent } from './service.js';

export const keepParentDefinition: OperationDefinition<
  ProposerInput,
  ProposerOutput,
  KeepParentConfig
> = {
  id: 'proposer.keep-parent',
  description: 'Keep the parent candidate without edits.',
  contract: proposerContract,
  configSchema,
  create: createKeepParent,
};
```

## Use RuntimeContext

Public fields and methods are defined in the [execution context](../../../src/contracts/runtime/execution.ts) and [service interfaces](../../../src/contracts/runtime/services.ts). Manager owns candidates, measurements, budgets, and call receipts; plugins access them through the following capabilities.

### Context fields

| Field                                | Meaning                                                                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `experimentId`                       | Current experiment ID.                                                                                                                    |
| `callId` / `bindingId`               | Current controlled call ID / binding name.                                                                                                |
| `idempotencyKey`                     | Current call's idempotency key, which can be passed to an external service supporting idempotent writes.                                  |
| `signal`                             | Business call cancellation signal; propagate it to external requests, child processes, and long-running work.                             |
| `cleanup`                            | Separate cleanup cancellation signal for resource release after business cancellation.                                                    |
| `scope`                              | Optional local budget scope containing `id`, `signal`, and `limits`; limit fields are `modelCalls`, `elapsedWallMs`, and `evidenceBytes`. |
| `directory`                          | Current call's data directory.                                                                                                            |
| `rootDirectory` / `dataDirectory`    | Host working root / Runtime data root, which defaults to `.rsi/` under the working root.                                                  |
| `artifacts` / `facts` / `workspaces` | Immutable artifact, fact storage, and temporary workspace services.                                                                       |
| `event`                              | Instance-scoped event pipeline; subscriptions and returned unsubscribe functions are covered in [Runtime events](runtime-events.md).      |

The current context has no `phase` field and does not infer report stages from step IDs. Reports use ordinary steps and explicit inputs.

### Reads, writes, and controlled calls

| Method                                                    | Result and use                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readCandidate(ref)`                                      | Return a Candidate containing `ref`, `artifactRef`, `parentRef`, and `experimentId`.                                                                                                                                                                                                  |
| `recordCandidate(artifactRef, parentRef)`                 | Return a candidate reference; normally used by the Application after target validation.                                                                                                                                                                                               |
| `readMeasurement(ref)` / `recordMeasurement(measurement)` | Read a measurement / validate and save a measurement, returning a reference. Identical submissions return a stable reference; storage owns a copy of the input.                                                                                                                       |
| `application(input)`                                      | Make a controlled call to the current Application using its `action` protocol.                                                                                                                                                                                                        |
| `applicationMetadata()`                                   | Return initialization metadata: `target`, `capabilities`, `initialCandidateRef`.                                                                                                                                                                                                      |
| `invoke(bindingName, input)`                              | Call an experiment binding through contract validation, budgets, receipts, and current revision selection.                                                                                                                                                                            |
| `invokeAgent(input)`                                      | Call the Agent binding named by `input.agentRef`, defaulting to `agent.default`; it does not automatically choose a binding named `agent`.                                                                                                                                            |
| `withInstance(candidateRef, capability, use)`             | Acquire an execution instance, call async `use(execution)`, and coordinate release on success, failure, and cancellation.                                                                                                                                                             |
| `readEvidence(refs, options?)`                            | Read evidence. Omit `format` for a JSON projection, or use `files` to read files; `view` accepts `execution / training-summary / delivery`, defaulting to `execution`; `maxBytes` is a positive safe integer requesting a byte limit, which scopes or projections may reduce further. |
| `charge(metric, amount)`                                  | Record usage and enforce budget checks; must be awaited.                                                                                                                                                                                                                              |
| `extend(properties)`                                      | Create a child scope inheriting this context and shadow only the supplied fields; nested objects remain shared, so create new values before changing them.                                                                                                                            |

`artifacts` supports `putJson`, `readJson`, `capture`, and `materialize`. `workspaces` supports `create(artifactRef?, parentCandidateRef?)`, `read(ref)`, and `release(ref)`; a workspace contains `ref`, `directory`, and `parentCandidateRef`. `facts` provides low-level `read / write / list` and optional `scan`; use the corresponding public management interfaces for candidates, measurements, and receipts.

Nested business calls use `invoke`, `invokeAgent`, or `application` to pass through Runtime controls. Do not instantiate another plugin directly to bypass these boundaries. Evaluators charge actual evaluation runs with `charge('evaluationRuns', 1)`; model backends charge actual request attempts to `modelCalls`. Runtime counts `operations`, so plugins must not charge them again.

Release call-owned workspaces, files, and temporary processes in `finally`; release long-lived instance resources in `dispose`. Propagate failure and cancellation. Return business statuses such as `no-change` or `failed` only where the contract defines them, rather than treating exceptions as successful output.

## Connect the plugin to a Policy and Recipe

The following Policy excerpt shows the plugin-related fields. A complete Policy still needs input/output Schemas and other required fields; see [Write a Policy](writing-policies.md). `with` is the input for each call, while `config` configures the binding; they are validated separately.

```yaml
require:
  proposer:
    contract: contract.proposer
defaults:
  bindings:
    proposer:
      plugin: proposer.keep-parent
      config:
        reason: Keep the baseline for this demonstration.
steps:
  - id: propose
    type: invoke
    use: proposer
    with:
      parent: ${{ application.initialCandidate }}
      goal: Check the plugin integration.
      evidenceRefs: []
```

A Recipe can override only configuration and retain the default implementation:

```yaml
bindings:
  proposer:
    config:
      reason: Keep the parent in this experiment.
```

### Binding fields and merge rules

`defaults.bindings.<name>` and `bindings.<name>` accept only `plugin` and `config`. `plugin` is an implementation ID and may be omitted in overrides; `config` must be an object, and omitting it means no configuration override. The Application belongs in Recipe `application` and must explicitly specify `plugin`.

| Situation                                                                                            | Assembly behavior                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Recipe omits an entry                                                                                | Inherit the Policy's default declaration.                                                                              |
| Same implementation, both field values are plain objects                                             | Merge recursively.                                                                                                     |
| Override value is an array, scalar, or `null`                                                        | Replace the whole value; `null` does not delete a field and must satisfy the Schema. `config` itself cannot be `null`. |
| Explicitly switch to a different `plugin`                                                            | Discard the old implementation's configuration and assemble from the new configuration and its Schema defaults.        |
| No implementation after merging, a required binding is missing, or an undeclared binding is supplied | Fail loading and identify the binding.                                                                                 |
| Implementation does not satisfy the required contract                                                | Fail loading.                                                                                                          |

Validate the final merged configuration and fill defaults, preserving path origins for each field. When replacing an Agent binding, also ensure the business plugin's `agentRef` points to it. Declaring an ID does not import code, and a file's existence does not enable a plugin. See the [binding loader](../../../src/runtime/loaders/binding.ts).

## Register an external extension for the CLI

Default extensions load from `~/.ember-rsi/plugins/<name>/index.mjs` in name order, before extra `--plugin-dir` directories. A missing home is allowed; invalid discovered extensions fail startup. Experiment data remains in the working directory's `.rsi/`. Embedded hosts can set `homeDirectory: false` for isolation.

Every CLI command accepts repeatable `--plugin-dir <directory>` options. Each directory contains an ESM `index.mjs` exporting `register(registry)`, which may be async. The extension and its dependencies must be built/resolvable before loading. For the three-file example above, use this entrypoint:

```js
// my-extension/index.mjs
import { keepParentDefinition } from './dist/proposer-keep-parent/index.js';

export function register(registry) {
  registry.registerOperation(keepParentDefinition);
}
```

| Registration API                   | Purpose                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `registerOperation(definition)`    | Register a plugin and its contract. Returns an unregister function; an implementation cannot be unregistered while in use.          |
| `registerContract(contract)`       | Register a contract separately so a Policy can resolve it before an implementation is bound. Declarations sharing an ID must agree. |
| `registerPolicy(id, absolutePath)` | Associate a Policy ID with a complete Policy YAML file; the file's top-level `id` must match.                                       |
| `catalog()`                        | Return arrays of registered `plugins` and `policies` IDs.                                                                           |

When built-in contracts cannot describe a new capability, declare one with `defineContract({ id, input_schema, output_schema })`, implement it in a plugin, and reference it in your custom Policy's `require`. Register the contract or implementation before reading that Policy. Reuse internal shared tools as ordinary modules rather than registering them as public plugins.

For a Policy declaring `proposer`, select this implementation through defaults or Recipe `bindings.proposer.plugin: proposer.keep-parent`, and supply the required `config.reason`. Pass the extension on each command that needs it:

```sh
ember-rsi validate ./my-recipe/recipe.yaml --plugin-dir ./my-extension
ember-rsi run ./my-recipe/recipe.yaml --id custom-run --plugin-dir ./my-extension
```

For a built-in repository extension, add its definition to [registerBuiltins](../../../src/runtime/builtins.ts) and rebuild. Creating a source file alone does not register it.

## Embed the Runtime

An external host can register definitions directly. This example assumes a complete `policy.my-search` file and a Recipe referencing it; validation and execution use the same Runtime:

```ts
import { resolve } from 'node:path';
import { createRuntime, validateRecipe } from 'ember-rsi';
import { keepParentDefinition } from './my-extension/dist/proposer-keep-parent/index.js';

const runtime = await createRuntime({
  rootDirectory: process.cwd(),
  homeDirectory: false,
});
try {
  runtime.registry.registerOperation(keepParentDefinition);
  runtime.registry.registerPolicy(
    'policy.my-search',
    resolve('./my-extension/policy.yaml'),
  );
  const recipePath = resolve('./my-recipe/recipe.yaml');
  const check = await validateRecipe(runtime, recipePath);
  console.log(check);
  const result = await runtime.manager.run(recipePath, { id: 'custom-run' });
  console.log(result.status, result.output);
} finally {
  await runtime.dispose();
}
```

### createRuntime options

All options may be omitted; see the [Runtime entrypoint](../../../src/runtime/context.ts). These are host API arguments, not a new Runtime YAML configuration file.

| Option                               | Default and use                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `rootDirectory`                      | Current process directory; sets the host working root.                                                               |
| `directory`                          | `.rsi/` under the working root; stores Runtime data.                                                                 |
| `homeDirectory`                      | Defaults to `~/.ember-rsi`; a string changes the extension home, and `false` disables user-wide extension loading.   |
| `pluginDirectories`                  | Additional extension directory array, relative to the current process directory; loaded after user-wide extensions.  |
| `context`                            | Supply a host `RuntimeContext` for Runtime to extend.                                                                |
| `registry`                           | Supply a Registry; Runtime still registers built-in plugins and Policies, so avoid registering those IDs beforehand. |
| `artifacts` / `facts` / `workspaces` | Replace default local storage and workspace services.                                                                |

### Inspect assembled objects

Import the `Recipe`, `Policy`, and `Binding` runtime classes from `ember-rsi`. `Recipe.load(recipePath, registry)` returns an assembled definition without initializing the Application, creating execution instances, or calling a model.

| Object  | Readable definition fields                                                                                                                                                                                                                                                 |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recipe  | `schemaVersion`, `id`, `description`, `sourcePath`, `application`, `policy`, `policyConfig`, `policyInput`, `bindings`, `budget`, `reflection`. `policy` is a Policy object; `policyInput` is evaluated after Application initialization.                                  |
| Binding | `name`, `definition`, `config`, `pluginId`. `pluginId` comes from `definition.id`; `config` is the final configuration.                                                                                                                                                    |
| Policy  | `id`, `description`, `sourcePath`, `directory`, `inputSchema`, `configSchema`, `stateSchema`, `outputSchema`, `inputDefaults`, `stateInitial`, `requirements`, `defaults`, `steps`, `output`, `digest`. Shared state belongs to each execution, not the definition object. |

`Binding.resolve({ name, required, registry, defaults?, override? })` assembles a binding; `defaults` and `override` each contain a `declaration` and its source `directory`. `binding.withConfig(config)` accepts a complete configuration with prepared paths and returns a new validated binding; it neither merges old configuration nor activates a revision. Runtime owns activation.

`recipe.toJSON()` exports persistable declarations with `id/config/input` under `policy` and `plugin/config` for bindings. `binding.toJSON()` and `policy.toJSON()` also return declarations; definition fields are treated as read-only snapshots. Never persist live `RuntimeContext` objects or factory functions as JSON.

## Handle recovery and cleanup

Runtime locks an experiment's Recipe, Policy, configuration, and declared resources. Recovery of unfinished experiments reads locked content and confirmed revisions, then checks registered implementation fingerprints; changed fingerprints prevent recovery. The host must still load the corresponding extensions. External writes need idempotency conditions or effects that can be reconciled.

| Confirmed state at interruption                          | Recovery behavior                                                     |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| Step result saved                                        | Restore result and state without repeating that step's effects.       |
| Successful call receipt saved, step result not yet saved | Reuse the receipt and complete the step record.                       |
| Call started but effects cannot be confirmed             | Stop automatic recovery and inspect the receipt and external effects. |
| Call not yet started                                     | Execute normally.                                                     |

Cleanup failures are separate from the experiment result. `runtime.dispose()` reports failed or still-pending cleanup; Runtime retains ownership until cleanup settles. After independently confirming that failed external resources have been released, a host can call `runtime.manager.reconcileCleanup(experimentId)` and then dispose again. Reconciliation does not repeat plugin disposal and refuses pending cleanup.

Direct registration in a host process does not modify a separately started CLI process. Use that host for management calls, or load the same extension through `--plugin-dir`. See [Run and resume experiments](running-experiments.md) for more operations.

After implementation, check necessary boundaries such as invalid configuration, contract mismatches, and cancellation cleanup, then run `validate` and a local deterministic experiment with the same extension. Repository engineering checks use the existing `pnpm check`; run `pnpm build` after changing repository source. Real model or benchmark evaluations require separate explicit runs; configuration validation and component tests do not establish that optimization took effect.
