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

By default, Reflection can edit configured `x-rsi-path` resources on eligible bindings. `targets.include` and `targets.exclude` select resources by binding and field. Use `'*'` for all eligible fields of a binding. Overlapping editable destinations are rejected. `goal` accepts a goal file and `implementation.config.prompt` accepts a prompt file. The built-in defaults are `reflection.agent`, a generic goal and a built-in `agent.pi`. An explicit `agentRef` must select a declared Agent binding.

The default trigger runs after each top-level loop iteration, or at experiment completion when the Policy has no top-level loop. Other boundaries are `loop-end`, `experiment-end`, and `after-step` with a serial step ID. `every` sets the number of matching boundaries per update. Memory runs before Reflection when both match. The evidence window defaults to `execution`. Use `training-summary` only for authorized scoring feedback. Filter it with `evidence.includeBindings`, `excludeBindings`, `includeSteps` or `excludeSteps`. A shared Reflection file can set `excludeBindings: [memory]` even when a Recipe disables Memory. An explicit `includeBindings: [memory]` requires Memory to be enabled. Empty windows skip the generator.

## Apply a revision to future experiments

```sh
arsi reflection list my-experiment
arsi reflection show <revisionID> --to ./exported-guidance
arsi reflection apply <revisionID> --to ./exported-guidance
```

Use `--to` to export built-in resources or save a revision in a dedicated directory you own. In the Dashboard, open **Reflection & Memory → Reflection → Preview application**, enter the export directory, and select **Preview destination**. A revision containing a single directory writes its contents directly there. Other revisions place resources under the binding name and configuration field path. Point future Recipe bindings at the exported resources to reuse them.

Omit the export directory to use the recorded source paths. Review additions, replacements and removals before applying. Applying requires all experiments in the same store to be finished or recovered. Protected roots and linked destinations are rejected. See [Memory](memory.md) for the shared experience directory.
