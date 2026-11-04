# Reflection guide

English | [简体中文](reflection_zh.md) · [Getting started](../getting-started.md) · [Runtime events](runtime-events.md)

Reflection reviews completed execution evidence and proposes guidance-resource changes for future plugin calls. Developers choose what to observe, what can change, and where to invoke it. The Runtime prepares input, validates proposals, and activates accepted revisions within the experiment.

The built-in Harness² Policy declares a Reflection configuration for the Invariant and Domain Proposers. Its `improve_guidance` step is commented out by default. See the [Harness² Policy](../../../src/policies/harness2/policy.yaml) and its [Reflection configuration](../../../src/policies/harness2/reflection.yaml).

## 1. Configure a Reflection module

Put a file such as `reflection.yaml` beside your Policy. The following example matches the Harness² binding names:

```yaml
evidence:
  - invariantProposer
  - domainProposer
  - composer
  - memoryUpdater
targets:
  invariantProposer:
    resources: [guidance]
  domainProposer:
    resources: [guidance]
goal: ./reflection-goal.md # The goal file describes what Reflection should improve.
implementation:
  contract: contract.reflection
  ref: reflection.agent
  config:
    evidenceView: execution
    agentRef: agent
budget:
  timeoutSeconds: 3600
```

| Field                     | Meaning                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `evidence`                | Nonempty, unique Policy binding names whose completed calls supply experience.                                                      |
| `targets`                 | Nonempty map of plugin bindings and authorized configured resource names, such as `guidance`.                                       |
| `goal`                    | Path to a nonempty UTF-8 file that states the improvement objective and observable conditions.                                      |
| `implementation.contract` | Required; must be `contract.reflection`.                                                                                            |
| `implementation.ref`      | Required registered implementation, such as `reflection.agent`.                                                                     |
| `implementation.config`   | Configuration checked by the selected implementation's schema. `reflection.agent` requires an explicit Agent binding in `agentRef`. |
| `budget`                  | Optional per-invocation model-call and timeout limits, also constrained by the experiment's remaining budget.                       |

For `reflection.agent`, omit `prompt` to use the bundled Reflection prompt, or supply your own file. Relative resource paths in this implementation configuration resolve against the selected Reflection file. Do not configure `maxContextBytes` or `maxModelCalls` here: context handling is internal, and model calls belong in `budget.modelCalls`.

Set `budget.modelCalls` to a nonnegative integer to limit model calls per invocation. Setting it to `0` prevents new model calls. Set `budget.timeoutSeconds` to a positive integer within the timer range to limit invocation time. Each omitted field leaves that dimension unrestricted by Reflection. Configured experiment and Agent limits also apply.

The example above and packaged Harness² Reflection file set a 60-minute local timeout without a model-call ceiling. An Agent's configured `executionTimeoutMs` also applies when Reflection invokes `agent.pi`. Omit `budget.timeoutSeconds` when no separate Reflection deadline is needed.

See the [configuration validator](../../../src/runtime/revisions/validation.ts) and [built-in example](../../../src/policies/harness2/reflection.yaml).

### Evidence supplied to Reflection

**The Runtime selects calls matching `evidence` bindings by completion time between consecutive Reflection boundaries.**

- The first window starts with the experiment. Terminal success, failure, cancellation, and unknown outcomes remain distinguishable.
- For version comparison, each selected plugin may also include its latest completed call from the previous revision. Size limits and missing or truncated evidence are recorded explicitly.

**`implementation.config.evidenceView` defaults to `execution`, which excludes scoring-side feedback. `training-summary` additionally permits existing authorized scoring, diagnostics, and returned hints.**

- Resource snapshots include the target bindings' configured Schema path resources, while modification authority applies only to names listed in `targets`.

- Reflection returns `skipped` without invoking the generator only when the window has no usable observations, including attributable late results.
- See [evidence collection](../../../src/runtime/revisions/evidence.ts) and [execution](../../../src/runtime/revisions/index.ts).

### How Reflection works

The default [Reflection prompt](../../../src/plugins/reflection-agent/prompt.md) explains how to reflect, while the `goal` file describes what to improve. Each Reflection call follows these steps:

1. **Review the material.** The main Agent receives the goal, current resources, and execution evidence for this round. It reads the relevant records and identifies problems worth addressing.
2. **Decide whether to delegate.** The main Agent can investigate directly or use `run_subagent` to pass questions and material to subagents. Subagents can delegate further, and all levels share the budget and cancellation mechanism.
3. **Consolidate proposed changes.** The main Agent combines findings supported by evidence, resolves conflicting suggestions, and supplies the complete new contents of authorized files with reasons for each change. If there is no useful improvement, it explains why and leaves the resources unchanged.
4. **Validate and activate.** The Runtime checks the authorized scope, content requirements, and revision constraints. It then saves and activates accepted revisions for subsequent calls in the current experiment. Completed calls and their results remain unchanged.

## 2. Invoke Reflection explicitly

A Policy selects its default file under `defaults.reflection.configFile`. This path resolves against the Policy file. Add a serial step after the calls you want to learn from:

```yaml
# Excerpt from a custom Policy based on Harness².
defaults:
  reflection:
    configFile: ./reflection.yaml
  # Keep the Policy's required bindings here.
steps:
  # Keep the proposal, evaluation, selection and Memory steps before this call.
  - id: improve_guidance
    type: reflection
```

This excerpt requires the rest of the Policy's schemas, dependencies, and flow. To use a different Reflection schedule, register your own Policy ID and select it from the Recipe. See [Policy registration](writing-policies.md#register-a-policy).

| Configuration and flow                            | Result                                                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| No declaration and no invocation                  | No Reflection module is loaded.                                                                                      |
| Declaration exists, but its step is never reached | Configuration is validated; the generator does not run.                                                              |
| Declaration exists and the step is reached        | Reflection executes and the Policy waits for its result; it may skip, make no change, reject, or activate revisions. |
| Invocation without a declaration                  | Rejected before execution.                                                                                           |

Reflection requires serial execution. The compiler/Runtime rejects calls in parallel branches, including nested parallel containers.

### Override the file from a Recipe

```yaml
# Recipe excerpt
reflection:
  configFile: ./reflection-custom.yaml
```

This selects a **complete replacement file** for the root Policy, which must already declare `defaults.reflection`. It does not merge individual fields or insert a call into the flow. The override path resolves against the Recipe; paths inside the selected file resolve against that file.

If the replacement omits `budget`, Reflection runs without a local model-call or time budget. Invalid replacements fail validation.

## 3. Let a custom plugin consume revised resources

Three pieces must be present: a Schema path declaration, authorization in Reflection, and a subsequent call that reads and uses the new resource.

Declare file/directory fields in the plugin's configuration schema:

```ts
import type { JsonSchema } from 'ember-rsi/contracts';

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    prompt: { type: 'string', 'x-rsi-path': 'file' },
    guidance: { type: 'string', 'x-rsi-path': 'directory' },
  },
  required: ['prompt', 'guidance'],
  additionalProperties: false,
};
```

Bind a registered implementation and provide real resource paths:

```yaml
# Policy defaults excerpt
bindings:
  domainProposer:
    plugin: proposer.custom
    config:
      prompt: ./prompts/domain.md
      guidance: ./guidance
```

In the Reflection file, `targets.domainProposer.resources: [guidance]` authorizes the configured guidance directory. It does not authorize `prompt` merely because `prompt` is a Schema path resource. Ordinary strings without `x-rsi-path` cannot be selected. Unknown resources, missing paths, or invalid file/directory types fail before the generator call.

The `configFile` interface authorizes creation and modification of resource content within the selected paths. Runtime validates the proposal's parent revisions and resource paths before activation. See [revision handling](../../../src/runtime/revisions/index.ts).

The plugin must read the paths it receives. The built-in Proposer calls `loadAgentPrompt(config)` for each edit request: it reads the base prompt, recursively reads sorted Markdown files from `config.guidance`, and appends the guidance text to the Agent request. See [shared editing code](../../../src/plugins/shared/agent-editing/index.ts). Merely declaring `x-rsi-path` does not insert file contents into prompts or change plugin behavior. Custom plugins own resource formats and their actual use.

## 4. Persistence, activation, and recovery

During an experiment, Reflection does **not** overwrite the source Policy package or original guidance directory. Accepted content is saved as an experiment revision, and effective binding configurations receive paths to its materialized resources. Explicit application to original user resources is described below.

With the default local store:

| Data                                      | Location                                                              |
| ----------------------------------------- | --------------------------------------------------------------------- |
| Immutable resource snapshots and changes  | `.rsi/artifacts/`                                                     |
| Materialized version resources            | `.rsi/experiments/<experiment-id>/revisions/<version-key>/resources/` |
| Revision, Reflection and activation facts | `.rsi/facts/`                                                         |

The execution sequence is proposal → scope/content/parent validation → revision persistence → activation → subsequent resource reads. Existing calls and results are not rewritten. Saving or activating a revision alone does not prove its guidance affected a model request; verify that later execution in the same unfinished experiment loaded and used it.

| Outcome                                    | Behavior                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `skipped` or `no-change`                   | Keep the effective revision.                                                                                                |
| `rejected`                                 | Do not activate the invalid proposal.                                                                                       |
| Failure before activation                  | Keep the previously effective configuration; inspect saved facts before retrying.                                           |
| Interruption during persistence/activation | Resume reconciles saved Reflection and activation records; conflicting parents or changed prepared input can fail recovery. |
| Resume the same experiment                 | Restore persisted effective resources and checkpoints.                                                                      |
| Start a new experiment                     | Start from its declared resources; no automatic inheritance from an earlier experiment.                                     |

### Apply a revision to future experiments

Run these commands with the same Runtime data directory as the experiment:

```text
ember-rsi reflection list [experimentId]
ember-rsi reflection show <revisionID>
ember-rsi reflection apply <revisionID>
```

- `list` includes initial, generated, and older revisions, optionally filtered by experiment.
- `show` displays the selected content, recorded target paths, and files that application would create, replace, or delete without writing them.
- `apply` restores the complete snapshot to its recorded original user-resource paths. Future experiments that select those paths can read it.

The following rules apply; see [application validation and writes](../../../src/runtime/revisions/application.ts):

1. Configure dedicated user guidance directories in Recipe bindings **before generating a revision**. Changing the Recipe afterward cannot redirect previously generated Reflection content to the new paths.
2. **Applying a snapshot overwrites local edits and removes files absent from that snapshot within the dedicated target directory; sibling directories and other resources are unaffected.**
3. Application is blocked while any experiment in that Runtime data directory is active or unresolved; finish or recover it first. `list` and `show` remain available. Separate Runtime data directories must not concurrently share these writable resources. New experiments do not automatically inherit earlier revisions.
