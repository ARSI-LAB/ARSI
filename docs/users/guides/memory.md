# Memory guide

English | [简体中文](memory_zh.md) · [Getting started](../getting-started.md)

Memory keeps reusable experience in a versioned directory of UTF-8 text files. Each experiment starts from a snapshot of its configured directory, or an empty tree when the directory is absent or unspecified. A successful update activates a new immutable version. Resume restores the experiment's active version.

## Configure Memory

Memory is enabled by default. A Policy can set `defaults.memory` and a Recipe can override it with `memory`. Use `false` to disable it, `true` to enable it with the Policy's configuration or built-in defaults, or `{ configFile: ./memory.yaml }` to select a complete configuration file. A Recipe file replaces the Policy file. Omitted fields use built-in defaults and file paths resolve relative to the file declaring them. Parameter Grid and Optuna disable both Memory and Reflection by default.

For compact feedback with bounded execution previews, a WikiSkill Recipe can select `memory: { configFile: ./wiki-memory.yaml }` with this configuration:

```yaml
directory: ./wiki
trigger: { on: after-step, step: train }
evidence:
  view: training-summary
  excludeSteps: [baseline, baseline_score, validate, test]
targets: { include: [proposer] }
```

The default trigger is `loop-iteration`, or `experiment-end` for a Policy without a top-level loop. Use `loop-end` for the end of a top-level loop or `after-step` with a serial step ID. `every: 2` runs on the second, fourth and subsequent even matches. Memory and Reflection track their own windows and cadence. Memory runs first when both match.

`evidence.view` defaults to `training`. Read authorized metrics and verifier feedback in `context/evolution/training-summary.json`. Use `context/evolution/packets/index.json` to find the corresponding execution packets and `context/evolution/evaluation-index.json` to locate redacted files. For verifier-blind Memory, explicitly select `execution`. Select `training-summary` for compact call summaries and bounded previews. Restrict observations with `includeBindings`, `excludeBindings`, `includeSteps` or `excludeSteps`. The Runtime collects calls, measurement projections, candidate changes and selector decisions. An empty window skips generation. An unsuccessful update keeps the previously active snapshot.

The built-in `memory.agent` supplies a generic prompt and goal. Set `goal` to a goal file or `implementation.config.prompt` to a prompt file. When `implementation.config.agentRef` is omitted, `memory.agent` reuses the only `contract.agent` binding declared by the Policy. If the Policy declares none or more than one, the Runtime creates `_evolutionAgent` using `agent.pi` with `MODEL_NAME`, `MODEL_ENDPOINT` and `MODEL_API_KEY`. To select a particular Agent, set `agentRef` to a declared `contract.agent` binding. Optional `budget.modelCalls`, `timeoutSeconds` and `evidenceBytes` bound one invocation.

## Read Memory during an Agent call

When an eligible binding calls `ctx.invokeAgent`, the Runtime mounts its pinned nonempty snapshot at `context/memory/` in a derived copy of the caller's Agent project. `AGENTS.md` and `CLAUDE.md` list the read-only files. The resulting Agent call receipt records `metadata.memoryVersionRef`. `targets.include` and `targets.exclude` select calling binding names. By default all Agent-calling business bindings are eligible. Memory and Reflection generators are excluded.

## Keep experience for another experiment

```sh
arsi memory list my-experiment
arsi memory show <versionID> --to ./exported-wiki
arsi memory apply <versionID> --to ./exported-wiki
```

With a configured `directory`, preview and apply default to that recorded path. Supply `--to` for an experiment that started without one. Inspect additions, replacements and removals before applying a complete snapshot. The Dashboard offers the same preview and confirmation under **Reflection & Memory → Memory**. Apply requires a dedicated user-owned directory and no active or unresolved experiment in the store. To reuse retained experience, point a future Memory configuration at that directory.

See [Reflection](reflection.md) for revision of individual plugins' resources.
