# Reflection guide

English | [简体中文](reflection_zh.md) · [Getting started](../getting-started.md)

Reflection proposes revisions to plugin resource files. The Runtime checks proposed edits, activates accepted revisions and creates plugin instances with the revised configuration. Subsequent calls record the acquired revision.

## Configure Reflection

Reflection is enabled by default. Set `defaults.reflection` in a Policy or `reflection` in a Recipe to `false`, `true` or `{ configFile: ./reflection.yaml }`. A Recipe file replaces the Policy's file. Using `true` preserves a configured Policy file. Settings and resource paths belong in the external file. For example, a Harness² configuration can restrict updates to two guidance directories:

```yaml
trigger: { on: loop-iteration, every: 2 }
evidence: { view: execution }
targets:
  include:
    invariantProposer: [guidance]
    domainProposer: [guidance]
implementation:
  config: { agentRef: agent }
budget: { timeoutSeconds: 3600 }
```

By default, Reflection can edit configured `x-rsi-path` resources on eligible bindings. `targets.include` and `targets.exclude` select resources by binding and field. Use `'*'` for all eligible fields of a binding. `goal` accepts a goal file and `implementation.config.prompt` accepts a prompt file. The built-in defaults are `reflection.agent`, a generic goal and a built-in `agent.pi`. An explicit `agentRef` must select a declared Agent binding.

The default trigger runs after each top-level loop iteration, or at experiment completion when the Policy has no top-level loop. Other boundaries are `loop-end`, `experiment-end`, and `after-step` with a serial step ID. `every` sets the number of matching boundaries per update. Memory runs before Reflection when both match.

When two selected fields refer to the same file, Reflection edits one copy. A selected directory also covers selected files inside it. If the project is reached through a symbolic link, use the same path to the project for all fields that share a resource. For example, a proposer can use `prompts/` while a summarizer uses `prompts/summarize.md`. Editing that file reloads both bindings. Editing another file in the directory reloads only the proposer. Each accepted update produces one revision for the experiment, including all affected bindings.

The evidence window defaults to `execution`. Use `training-summary` only for authorized scoring feedback. Filter it with `evidence.includeBindings`, `excludeBindings`, `includeSteps` or `excludeSteps`. Step filters apply to Policy calls. Reflection selects Memory update receipts through binding filters. The `execution` view also exposes the updated Memory snapshot when available. The `training-summary` view includes only the receipt for the update. A shared Reflection file can set `excludeBindings: [memory]` even when a Recipe disables Memory. An explicit `includeBindings: [memory]` requires Memory to be enabled. Empty windows skip the generator.

## Apply a revision to future experiments

```sh
arsi reflection list my-experiment
arsi reflection show <revisionID> --to ./exported-guidance
arsi reflection apply <revisionID> --to ./exported-guidance
```

Use `--to` to export built-in resources or save a revision in a dedicated directory you own. In the Dashboard, open **Reflection & Memory → Reflection → Preview application**, enter the export directory, and select **Preview destination**. A revision with a single directory root exports its contents directly into the destination. For other layouts, read `sourceRoots` in the preview for the resource paths. Shared roots use a single export path for all owners. Point future Recipe bindings at the exported resources to reuse them.

Use `arsi reflection list <experiment-id>` to see the revision chain, newest first. Each generated revision lists its affected bindings in `changedBindings`. Preview with `arsi reflection show <revisionID>` and apply with `arsi reflection apply <revisionID>` to write the cumulative changes to the original locations in one operation. A generated revision writes or exports only roots that differ from the initial snapshot. To restore the baseline, preview and apply the **Initial version** from the list. Its preview compares every selected root with the current destination. Use `arsi reflection apply <initialRevisionID> --to ./baseline` to export the complete baseline.

Review the listed changes before applying. Applying requires all experiments in the same store to be finished or recovered. An unchanged built-in root does not block a generated revision from updating a user directory. To write a protected root, or a resource whose source path passes through a symbolic link, choose a dedicated export directory with no symbolic links in its path. Reflection can run with source resources under a linked ancestor. See [Memory](memory.md) for the shared experience directory.
