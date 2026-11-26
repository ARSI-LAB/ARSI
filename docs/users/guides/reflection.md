# Reflection guide

English | [简体中文](reflection_zh.md) · [Getting started](../getting-started.md)

Reflection proposes revisions to plugin resource files. The Runtime checks proposed edits, activates accepted revisions and creates plugin instances with the revised configuration. Subsequent calls record the acquired revision.

## Configure Reflection

The six built-in Agent Policies each supply a Reflection configuration. A Recipe inherits that file when it omits `reflection` or sets it to `true`. Set `reflection: false` to disable the module, or `reflection: { configFile: ./reflection.yaml }` to replace the entire Policy file. If the Policy supplies no file, Reflection stays off until the Recipe supplies one. Setting `true` without an available file is a load error.

The file must grant access to at least one local resource under `targets.include`. This Harness² configuration grants access to the local resources of its two Proposers.

```yaml
trigger: { on: loop-iteration, every: 2 }
evidence: { view: execution }
targets:
  include:
    invariantProposer: '*'
    domainProposer: '*'
budget: { timeoutSeconds: 3600 }
```

WikiSkill, Gym RSI, GEPA and Parameter Agent use `proposer: '*'` to select all local resources configured on `proposer.agent`. These include the main `prompt`, `skills` directories and role prompts in `subagents`. Harness² grants the same access to each of its two Proposers. Operator Search explicitly selects `proposer: [promptsDirectory]` and `summarizer: [promptFile]` so the benchmark inputs and retrieval scripts remain outside its edit scope. Use a field list such as `proposer: [prompt]` to narrow a grant. `['*']` is also accepted as a wildcard. A named field pointing to a URL, or a wildcard with no local matches, fails validation. `targets.exclude` removes fields from the selection. At least one editable resource must remain.

`goal` accepts a goal file and `implementation.config.prompt` accepts a prompt file. The built-in `reflection.agent` uses a generic goal. When `implementation.config.agentRef` is omitted, it reuses the only `contract.agent` binding declared by the Policy. If the Policy declares none or more than one, the Runtime creates `_evolutionAgent` using the built-in `agent.pi`. An explicit `agentRef` must name a declared `contract.agent` binding.

The default trigger runs after each top-level loop iteration, or at experiment completion when the Policy has no top-level loop. Other boundaries are `loop-end`, `experiment-end`, and `after-step` with a serial step ID. `every` sets the number of matching boundaries per update. Memory runs before Reflection when both match.

When two selected fields refer to the same file, Reflection edits one copy. A selected directory also covers selected files inside it. If the project is reached through a symbolic link, use the same path to the project for all fields that share a resource. For example, a proposer can use `prompts/` while a summarizer uses `prompts/summarize.md`. Editing that file reloads both bindings. Editing another file in the directory reloads only the proposer. Each accepted update produces one revision for the experiment, including all affected bindings.

The evidence window defaults to `training`. It combines authorized feedback in `context/evolution/training-summary.json` with redacted execution files, call records and eligible child Agent diagnostics and workspaces. For verifier-blind Reflection, set `evidence: { view: execution }`. Use `training-summary` for compact call summaries and bounded previews. Filter it with `evidence.includeBindings`, `excludeBindings`, `includeSteps` or `excludeSteps`. Step filters apply to Policy calls. Reflection selects Memory update receipts through binding filters. Both `training` and `execution` expose the updated Memory snapshot when available. Memory may retain observations from its own evidence window. Align its filters with Reflection’s held-out split or exclude the `memory` binding. The `training-summary` view includes only the receipt for the update. A shared Reflection file can set `excludeBindings: [memory]` even when a Recipe disables Memory. An explicit `includeBindings: [memory]` requires Memory to be enabled. Empty windows skip the generator.

## Apply a revision to future experiments

Use `arsi reflection list <experiment-id>` to find a revision, newest first. A generated revision lists its affected bindings in `changedBindings`. Once all experiments in the same store have finished or been recovered, preview the cumulative changes with `arsi reflection show <revisionID>`. Use `arsi reflection apply <revisionID>` to write them to their recorded destinations.

> [!IMPORTANT]
> **Protected paths and in-place writes.** During an experiment, Reflection stores accepted revisions under `.rsi/` and hot-reloads the affected bindings for subsequent calls. The original files stay intact, including resources supplied by a built-in Policy.
>
> In-place `apply` refuses to overwrite the framework’s `src/policies/` and `src/plugins/` trees, paths under `dist/`, `node_modules/`, `.rsi/` or `.git/`, the whole project root or a filesystem root. It also rejects a destination if the path itself or any ancestor is a symbolic link or Windows junction.
>
> A generated joint revision writes only resource roots whose contents or file modes differ from the initial snapshot. If only user-owned roots changed, an unchanged built-in root does not block their write-back. If a protected root changed, export the revision.

**To reuse a revised built-in resource in future experiments**

1. Run `arsi reflection show <revisionID> --to ./exported-resources`. Review the changes, use `sourceRoots` to identify each binding and resource, and check `destinations` for the actual export paths. In the Dashboard, open **Reflection & Memory → Reflection → Preview application**, enter the export directory, and select **Preview destination**.
2. Run `arsi reflection apply <revisionID> --to ./exported-resources` to export to a dedicated user-owned directory whose path contains no symbolic links or junctions. A revision with one directory root places its contents directly there. Bindings that share a root share its export path.
3. Edit the corresponding binding in `recipe.yaml` to point to the exported files or directories. For a Proposer, this might mean changing `prompt`, an entry in `skills`, or a role’s `subagents[].prompt`. Later experiments can load and revise those copies in place.

**For repeated in-place updates**, put every resource you intend to evolve in a dedicated subdirectory of your own project when you first write the Recipe. Point the binding at those copies before starting the experiment. Run `arsi doctor recipe.yaml` and check `reflection.targets` for a built-in resource export notice. Use `reflection show` to verify the write destinations for a particular revision.

To restore the baseline, preview and apply the **Initial version**. Its preview compares every selected root with the current destination. Use `arsi reflection apply <initialRevisionID> --to ./baseline` to export the complete baseline. See [Memory](memory.md) for the shared experience directory.
