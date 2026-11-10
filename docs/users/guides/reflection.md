# Reflection guide

English | [简体中文](reflection_zh.md) · [Getting started](../getting-started.md) · [Runtime events](runtime-events.md)

Reflection improves target plugins using execution evidence so later calls adopt the revised behavior. This guide explains how to select target plugins, configure allowed changes, and invoke Reflection from a Policy.

- The built-in Harness² Policy configures Reflection to improve the Invariant and Domain Proposers, currently authorizing changes to their `guidance`. Its `improve_guidance` step is commented out by default. See the [Harness² Policy](../../../src/policies/harness2/policy.yaml) and its [Reflection configuration](../../../src/policies/harness2/reflection.yaml).

## 1. Configure a Reflection module

`reflection.yaml` specifies which execution records to consult, which plugins to improve, which parts of those plugins may change, and which Reflection plugin and Agent perform the reflection. Put it beside the Policy. This example uses binding names declared by Harness²; adjust them to match your own Policy:

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

### Which records to consult and which plugins to improve

| Field                              | Required | Purpose                                                                              | How to fill it                                                                                                                                                                              |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidence`                         | Yes      | Choose which plugin calls supply execution records for reflection.                   | List existing Policy binding names, such as `[domainProposer, composer]`. Include at least one, with no duplicates.                                                                         |
| `targets`                          | Yes      | Choose the target plugins to improve in this Reflection invocation.                  | Use Policy binding names as keys, such as `domainProposer`, and list `resources` under each. Select at least one binding.                                                                   |
| `targets.<binding name>.resources` | Yes      | Limit which configuration resources of that plugin may change.                       | List resource field names from the plugin configuration, such as `[guidance]`. Each field must have a configured path and be declared as a file or directory resource in the plugin Schema. |
| `goal`                             | Yes      | Specify which problem the target plugin should solve and what improvement to pursue. | Supply a goal file path, such as `./reflection-goal.md`. The file must contain nonempty UTF-8 text.                                                                                         |

- The example consults execution records from four bindings and improves the two Proposers by changing their `guidance`. For example, if `domainProposer` has `guidance: ./guidance` in its configuration, `resources: [guidance]` authorizes changes to files inside that `./guidance` directory.

### Who runs Reflection

`implementation` selects the Reflection plugin that proposes improvements to the target plugins. `implementation.config` holds configuration passed to that plugin. The configuration fields below apply to the built-in `reflection.agent`:

| Field                                | Required | Purpose                                                                              | How to fill it                                                                                                                                              |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `implementation.contract`            | Yes      | Declare the public interface required of the selected plugin.                        | Current built-in contract: `contract.reflection`.                                                                                                           |
| `implementation.ref`                 | Yes      | Choose the implementation that performs reflection and proposes plugin improvements. | Supply a registered plugin ID implementing that contract, such as `reflection.agent`.                                                                       |
| `implementation.config.agentRef`     | Yes      | Choose the Agent that performs the reflection.                                       | Supply an existing Agent binding name in the Policy, such as `agent`. That binding configures the backend and model.                                        |
| `implementation.config.evidenceView` | No       | Control which evidence contents Reflection can read.                                 | Use `execution` (default) for execution evidence, or `training-summary` when existing authorized scoring feedback is allowed. See the evidence scope below. |
| `implementation.config.prompt`       | No       | Instruct Reflection how to analyze evidence and improve the target plugins.          | Supply a custom prompt file path, such as `./reflection-prompt.md`. Omit it to use the built-in prompt.                                                     |

### Limit the cost of one Reflection call

The entire `budget` object is optional, and either field can also be omitted independently:

| Field                   | Purpose                                                    | How to fill it                                                                                                         |
| ----------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `budget.modelCalls`     | Cap new model calls made by one Reflection invocation.     | A nonnegative integer, such as `10`. `0` prevents new model calls. Omit it to apply no local limit for this dimension. |
| `budget.timeoutSeconds` | Cap the duration of one Reflection invocation, in seconds. | A positive integer, such as `3600` for 60 minutes. Omit it to apply no local limit for this dimension.                 |

Experiment budgets and the Agent's own limits still apply, such as `agent.pi`'s `executionTimeoutMs`.

### Evidence supplied to Reflection

**The Runtime selects calls matching `evidence` bindings by completion time between consecutive Reflection boundaries.**

- The first window starts with the experiment. Terminal success, failure, cancellation, and unknown outcomes remain distinguishable.
- Size limits and missing or truncated evidence are recorded explicitly.

**`implementation.config.evidenceView` defaults to `execution`, which excludes scoring-side feedback. `training-summary` additionally permits existing authorized scoring, diagnostics, and returned hints.**

For view definitions and visibility, see [Evidence](../concepts/architecture.md#evidence).

- Resource snapshots include the target bindings' configured Schema path resources, while modification authority applies only to names listed in `targets`.
- Existing text resources retain their file permissions during content edits, including modes such as `0600`, `0640`, and `0664`. Permission changes and executable files are rejected; newly created text files may use non-executable permissions determined by the host's umask.

- Reflection returns `skipped` without invoking the generator only when the window has no usable observations, including attributable late results.
- See [evidence collection](../../../src/runtime/revisions/evidence.ts) and [execution](../../../src/runtime/revisions/index.ts).

### How Reflection works

The default [Reflection prompt](../../../src/plugins/reflection-agent/prompt.md) explains how to reflect, while the `goal` file describes what to improve. Each Reflection call follows these steps:

1. **Review the material.** The main Agent receives the goal, current resources, and execution evidence for this round. It reads the relevant records and identifies problems worth addressing.
2. **Decide whether to delegate.** The main Agent can investigate directly or delegate a focused question to `reflection-reviewer` in the same workspace. Pi uses `subagent` and shares the Reflection budget and cancellation. Codex uses native role delegation. See [Agent backends](configuration.md#agent-and-environment-variables).
3. **Consolidate plugin improvements.** The main Agent combines evidence-based suggestions for the target plugins, resolves conflicting suggestions, and supplies the complete new contents of authorized files with reasons for each change. If there is no useful improvement, it explains why and leaves the resources unchanged.
4. **Validate and activate.** The Runtime checks the authorized scope, content requirements, and revision constraints. Once these checks pass, it saves and activates the plugin revisions for subsequent calls in the current experiment.

## 2. Invoke Reflection explicitly

### Step 1: Declare the Reflection configuration file

Set `defaults.reflection.configFile` in the Policy to the configuration file written in section 1. The path resolves relative to the Policy file:

```yaml
# Policy excerpt
defaults:
  reflection:
    configFile: ./reflection.yaml
```

The Runtime validates this configuration when loading the Policy. The Reflection step added in step 2 determines when it runs.

#### Override the file from a Recipe

If an experiment needs a different Reflection configuration, select it in the Recipe:

```yaml
# Recipe excerpt
reflection:
  configFile: ./reflection-custom.yaml
```

This `reflection.configFile` resolves relative to the Recipe file. The selected file follows section 1 and completely replaces the Policy's default configuration, so the Policy must already declare `defaults.reflection`. The Policy still determines when Reflection runs.

### Step 2: Choose when to invoke Reflection

Add a `type: reflection` step at the desired point in the Policy's `steps`. For example, place it after a round of proposal, evaluation, selection, and Memory calls so the next round's plugin calls can use the improved revisions:

```yaml
# Policy steps excerpt
steps:
  # Existing proposal, evaluation, selection and Memory steps go here.
  - id: improve_guidance
    type: reflection
  # Later calls to target plugins use the activated revisions.
```

`id: improve_guidance` names the step and can be changed; `type: reflection` runs Reflection. **The Policy waits for this Reflection call to finish before continuing with later steps.**

- **Reflection must run serially, outside parallel branches.**
- If later steps need the result, read `steps.improve_guidance.output`.

Adjust the step's position in the Policy to control how often Reflection runs:

- **After every optimization round**: put it at the end of the optimization loop, giving the sequence “current round → Reflection → next round”.
- **Once after all optimization rounds**: put it after the optimization loop, giving the sequence “all rounds → Reflection”.

## 3. Integrate a custom plugin with Reflection

Take a custom proposal plugin named `proposer.custom`: it reads a prompt and guidance documents to generate proposals. Reflection can improve its proposal behavior by updating those contents.

### Step 1: Declare the files and directories the plugin uses

In the plugin's configuration Schema, declare `prompt` as a file path and `guidance` as a directory path. The `x-rsi-path` marker lets the Runtime recognize these paths and read their contents:

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

### Step 2: Configure the actual paths in the Policy

Declare a `domainProposer` binding in the Policy, select the registered `proposer.custom` plugin, and configure the file and directory it should read:

```yaml
# Policy excerpt
require:
  domainProposer:
    contract: contract.proposer
defaults:
  bindings:
    domainProposer:
      plugin: proposer.custom
      config:
        prompt: ./prompts/domain.md
        guidance: ./guidance
```

- Before reflection starts, the Runtime checks that the file and directory exist and match their declared Schema types.

### Step 3: Select the target plugin and allowed changes

In the `reflection.yaml` from section 1, select this plugin as the source of observations and the target of improvements:

```yaml
# Reflection configuration excerpt
evidence: [domainProposer]
targets:
  domainProposer:
    resources: [guidance]
```

Here, `domainProposer` refers to the binding from step 2, and `resources: [guidance]` selects its configured `./guidance` directory. Reflection uses this plugin's execution records to improve it by revising guidance documents in that directory. To also allow prompt changes, use `resources: [prompt, guidance]`.

### Step 4: Use the revised contents in the plugin

**The plugin must read and use the revised configuration supplied by the Runtime in later calls for Reflection's changes to affect its behavior.**

- For example, the built-in `proposer.agent` reads the `prompt` file and Markdown files in `guidance`, then passes their contents to the Agent.

- Custom plugins must use the revised contents according to their own logic.

## 4. Persistence, activation, and recovery

During an experiment, Reflection does **not** overwrite the source Policy package or the plugin's original contents. Validated changes are saved as experiment revisions, with the original target paths recorded for explicit application. The commands below explain how to apply them to the original user resources.

With the default local store:

| Data                                                   | Location                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| Resource contents and change records for each revision | `.rsi/artifacts/`                                                     |
| Materialized version resources                         | `.rsi/experiments/<experiment-id>/revisions/<version-key>/resources/` |
| Revision, Reflection and activation records            | `.rsi/facts/`                                                         |

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

Alternatively, open the experiment details in the [dashboard](running-experiments.md#dashboard), go to **Reflection & Memory → Reflection**, select a revision, and click `Preview application`. In the `Apply to source files` dialog, review the destination paths and files to create, replace, or delete, select the confirmation checkbox, and click `Apply changes`.

Both CLI and dashboard application follow these rules; see [application validation and writes](../../../src/runtime/revisions/application.ts):

1. Configure dedicated user guidance directories in Recipe bindings **before generating a revision**. Changing the Recipe afterward cannot redirect previously generated Reflection content to the new paths.
2. **Applying a snapshot overwrites local edits and removes files absent from that snapshot within the dedicated target directory.**
3. Application is blocked while any experiment in that Runtime data directory is active or unresolved; finish or recover it first. `list` and `show` remain available.
