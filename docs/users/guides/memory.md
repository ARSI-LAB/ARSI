# Memory guide

English | [简体中文](memory_zh.md) · [Getting started](../getting-started.md)

This guide explains how to configure and invoke Memory in a Policy, save execution experience, and pass it to later steps.

Memory stores experience documents for later optimization, such as effective execution methods, lessons from failures, and improvement suggestions. `memory.agent` organizes and updates these documents from evidence supplied by the Policy.

## 1. Use Memory in a built-in Policy

Harness², WikiSkill and parameter.agent configure the Memory plugin, its prompt, its Agent binding, and the steps that save and consume its output:

| Policy    | Evidence view      | When Memory is used                                                                                                                                              |
| --------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness²  | `execution`        | Update the experience documents after each task and pass `memoryRef` to Proposers in later tasks. Enabled by default through `policy.config.memory`.             |
| WikiSkill | `training-summary` | Update the experience documents after each round's training evaluation and pass `memoryRef` to that round's Proposer. There is no `memory` configuration switch. |

`parameter.agent` enables Memory with `policy.config.memory: true` (default:
`false`). It consolidates each measured batch using `training-summary`, candidate
sources and selector outcomes, then delivers the saved experience to subsequent
proposals. Its output includes `memoryRef`. It retains the previous version on an
ordinary update failure and does not automatically inherit another experiment.
See the [parameter Policy](../../../src/policies/parameter/agent/policy.yaml).

See the [Harness² Policy](../../../src/policies/harness2/policy.yaml) and [WikiSkill Policy](../../../src/policies/wikiskill/policy.yaml) for their calls and state updates. The [Evidence views](../concepts/architecture.md#evidence) describe what each view exposes.

## 2. Add Memory to a custom Policy

### Step 1: Configure the Memory binding and state in the Policy

First configure a Memory plugin in the Policy and use a state field to store the current document version's identifier. The example declares a `memoryUpdater` binding requiring `contract.memory`, selects `memory.agent`, and uses `state.memoryRef` to track the document version.

Merge the following excerpt into an existing Policy. This example assumes an Agent binding named `agent` has already been declared and configured.

```yaml
# Policy excerpt
require:
  memoryUpdater:
    contract: contract.memory
defaults:
  bindings:
    memoryUpdater:
      plugin: memory.agent
      config:
        agentRef: agent
        prompt: ./memory.md
        evidenceView: execution
state_schema:
  type: object
  properties:
    memoryRef:
      type: [string, 'null']
  required: [memoryRef]
  additionalProperties: false
state:
  memoryRef: null # No experience yet.
```

- `prompt` is the required instruction file that tells Memory how to consolidate experience. It should describe what to learn and how to organize the documents.
- `evidenceView` defaults to `execution`; select `training-summary` when the learning flow permits training scores and feedback. Additional settings and supported limits are defined by the [configuration Schema](../../../src/plugins/shared/agent-editing/schema.ts) and [configuration guide](configuration.md).

### Step 2: Update and use experience in the Policy flow

**Input: The Policy supplies these fields through the call step's `with`.**

| Field             | Required | Type                         | Purpose                                                                                                                                                                          |
| ----------------- | -------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memoryRef`       | Yes      | `string \| null`             | The current experience document version's identifier. You can pass `null` on the first call; on later calls, pass the previously returned value to build on existing experience. |
| `goal`            | Yes      | `string`                     | What to learn in this call, such as effective methods and causes of failure.                                                                                                     |
| `evidenceRefs`    | Yes      | `string[]`                   | References to evidence to analyze, such as a `measurementRef` returned by evaluation. Memory reads the contents exposed by `evidenceView`.                                       |
| `sources`         | No       | `{ candidateRef: string }[]` | Candidates to consult. `memory.agent` reads their file contents as context for consolidating experience.                                                                         |
| `observations`    | No       | `object \| null`             | Additional observations supplied by the Policy.                                                                                                                                  |
| `comparison`      | No       | `object`                     | Comparison data covering the baseline, trial candidates, and selection result, used to analyze which changes worked.                                                             |
| `editConstraints` | No       | `object`                     | Limits on which experience files can change and the size of those changes.                                                                                                       |

**Output: The Policy reads `steps.<call step ID>.output`. All fields below are returned.**

| Field       | Type             | How the Policy uses it                                                                                                                                                                                                               |
| ----------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status`    | `string`         | Check the result: `updated` means the documents changed, `no-change` means no update was needed, and `failed` means the update failed.                                                                                               |
| `memoryRef` | `string \| null` | The resulting experience document version's identifier. Save it in state for the next Memory call and later plugins. If there is no update or the call fails, it retains the input value; it remains `null` if no experience exists. |
| `changeRef` | `string \| null` | The identifier of the change record, which can be used to inspect the edits. Present only for `updated`; otherwise `null`.                                                                                                           |
| `reason`    | `string`         | Why the documents changed, needed no update, or failed to update, for Policy decisions or records.                                                                                                                                   |

See the [Memory contract](../../../src/contracts/plugin-types/memory.ts) for complete field definitions.

**Example: Evaluate → update experience → save the result → propose.**

As shown below, after evaluation you can call `memoryUpdater` to update the experience documents, save the returned `memoryRef` in Policy state, and pass it to `proposer`. Place this excerpt after an evaluation step named `evaluate`; it assumes a declared `proposer` binding and an `input.candidateRef` supplied by the Policy's input:

```yaml
# Policy steps excerpt; keep the existing evaluate step before these calls.
steps:
  - id: remember
    type: invoke
    use: memoryUpdater
    with:
      memoryRef: ${{ state.memoryRef }}
      goal: Preserve reusable execution patterns, sources, and uncertainty.
      evidenceRefs:
        - ${{ steps.evaluate.output.measurementRef }}
  - id: save_memory
    type: state
    state:
      memoryRef: ${{ steps.remember.output.memoryRef }}
  - id: propose
    type: invoke
    use: proposer
    with:
      parent: ${{ input.candidateRef }}
      goal: Improve the candidate using authorized evidence and experience.
      evidenceRefs:
        - ${{ steps.evaluate.output.measurementRef }}
      memoryRef: ${{ state.memoryRef }}
```

**For an Agent to use Memory in later steps, the plugin must read the experience documents identified by `memoryRef` and pass their contents to the Agent as context. The built-in `proposer.agent` already does this; custom plugins that use Memory need to implement this logic themselves.**

## 3. Memory execution results, storage, and recovery

| Result      | Behavior                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `updated`   | Save a new version of the experience documents and return its `memoryRef`, the change record `changeRef`, and a reason. The Policy saves the new `memoryRef` for later steps.      |
| `no-change` | Keep the previous `memoryRef` and return `changeRef: null`; the experience documents are unchanged.                                                                                |
| `failed`    | Return the previous `memoryRef`, `changeRef: null`, and an error reason. The previous document version is retained; the call receipt remains failed while the Policy can continue. |

In the [dashboard](running-experiments.md#dashboard), open experiment details and go to **Reflection & Memory → Memory** to inspect each update's status and reason. Use `Changes` to compare changes, `Full contents` to read the experience documents, and `View call` to inspect the corresponding call.

Whenever content changes, the Runtime saves a new version and leaves existing versions unchanged. `memoryRef` identifies one version of the experience documents, and `changeRef` identifies the record of that update's changes.

With local storage, the Runtime saves document contents and directory information under `.rsi/artifacts/`, while Policy checkpoints record the current `memoryRef`. **Resuming the same experiment continues with the saved document version. The built-in Policies initialize Memory as empty (`memoryRef: null`) for each new experiment, so they do not automatically inherit an earlier experiment's Memory.**

An ordinary Memory update failure alone does not cancel the experiment. Cancellation, experiment budget exhaustion, and failures to save critical Runtime records still stop execution. See [cancellation and resume](running-experiments.md#cancellation-and-resume) and the [Memory implementation](../../../src/plugins/memory-agent/service.ts).
