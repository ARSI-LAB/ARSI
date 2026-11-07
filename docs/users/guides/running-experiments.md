# Run and inspect experiments

English | [简体中文](running-experiments_zh.md) · [Getting started](../getting-started.md)

This guide explains how to validate, run, inspect, cancel, and resume experiments and troubleshoot them through the CLI and dashboard.

Run commands from the workspace that should own the experiment's `.rsi/` directory. Recipe resource paths resolve against their declaring files; the default data store follows the process's working directory. Separate CLI and dashboard processes observe the same store when launched from the same workspace.

## CLI commands

Use `ember-rsi --help` or `<command> --help` for the installed build's syntax. From a source checkout without a global install, use `pnpm ember-rsi`.

| Command                                                     | Purpose                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ember-rsi catalog`                                         | List registered plugin and Policy IDs.                                                                                                                                                                                                                                                               |
| `ember-rsi list plugins`                                    | Inspect plugin descriptions, contracts, Schemas, and compatible Policy bindings.                                                                                                                                                                                                                     |
| `ember-rsi list policies`                                   | Inspect Policy descriptions, Schemas, requirements, and compatible plugins.                                                                                                                                                                                                                          |
| `ember-rsi validate <recipe.yaml>`                          | Validate configuration and wiring without running the experiment.                                                                                                                                                                                                                                    |
| `ember-rsi run <recipe.yaml> --id <experiment-id>`          | Start a real experiment and persist its records.                                                                                                                                                                                                                                                     |
| `ember-rsi list`                                            | List saved experiments.                                                                                                                                                                                                                                                                              |
| `ember-rsi show <experiment-id>`                            | Print saved experiment status, output, and error information.                                                                                                                                                                                                                                        |
| `ember-rsi cancel <experiment-id>`                          | Send a cancellation request to the specified experiment.                                                                                                                                                                                                                                             |
| `ember-rsi run <recipe.yaml> --id <experiment-id> --resume` | Recover the identified experiment from its saved state.                                                                                                                                                                                                                                              |
| `ember-rsi dashboard --port <port>`                         | Serve a local web dashboard for inspecting experiments.                                                                                                                                                                                                                                              |
| `ember-rsi reflection list [experiment-id]`                 | List persisted revisions, optionally for one experiment.                                                                                                                                                                                                                                             |
| `ember-rsi reflection show <revisionID>`                    | Inspect revision content and planned resource changes.                                                                                                                                                                                                                                               |
| `ember-rsi reflection apply <revisionID>`                   | Write the snapshot to its recorded user-resource paths; see the [Reflection rules](reflection.md#apply-a-revision-to-future-experiments).                                                                                                                                                            |
| `ember-rsi validate <recipe.yaml> --plugin-dir <directory>` | Validate a Recipe that uses custom plugins or Policies. Pass the same extension directories when running, resuming, or starting the dashboard; repeat `--plugin-dir` for multiple directories. See [extension registration](writing-plugins.md#method-2-register-an-external-extension-for-the-cli). |

## Validate and start

For example, validate and start an experiment with:

```sh
ember-rsi validate my-experiment/recipe.yaml
ember-rsi run my-experiment/recipe.yaml --id terminal-skills-01
```

- `validate` checks the Recipe, plugin configuration, contract compatibility, Policy compilation, and declared Reflection resources.

Inspect progress from another terminal in the same workspace:

```sh
ember-rsi list
ember-rsi show terminal-skills-01
```

## Read results and evidence

Facts and execution records live in `.rsi/facts/`, immutable artifacts in `.rsi/artifacts/`, and experiment-specific working resources in `.rsi/experiments/<experiment-id>/`.

AgentBench and InferenceBench map each task's execution status from the SDK's `executionStatus`, separately from its score or correctness status. A successfully completed execution can receive a zero score or produce an incorrect answer; inspect metrics and evaluation feedback to assess quality. Cancellation, execution failure, and unknown execution outcomes retain their respective statuses.

- Preserve the store and original resource files when resuming.

## Cancellation and resume

```sh
ember-rsi cancel terminal-skills-01
ember-rsi show terminal-skills-01
```

A cancellation request does not stop all work immediately. Runtime propagates the cancellation signal and cleans up its own resources. Check the final status and cleanup records.

- Pressing Ctrl+C in the terminal running the CLI also sends a cancellation signal.

To resume, use the same workspace, original Recipe path, experiment ID, and required extensions:

```sh
ember-rsi run my-experiment/recipe.yaml --id terminal-skills-01 --resume
```

Runtime restores locked definitions, budget usage, effective revisions, call receipts, and checkpoints, and rejects incompatible changes.

- Resume does not reset counters or the experiment's start time; a configured elapsed-wall budget includes downtime.

## Dashboard

```sh
ember-rsi dashboard --port <port>
```

Run from an experiment workspace that already contains `.rsi/`. The web dashboard displays experiments, summaries, candidates, diffs, measurements, calls, Agent traces, results, and charts, as shown below.

- Start, resume, and cancel experiments through the CLI.
- The development frontend proxies `/api` to port 4317 by default.

![rsi-studio-wikiskill-compact](../assets/rsi-studio-wikiskill-compact.gif)

## Troubleshooting

| Symptom                                                           | Check                                                                                                                                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown plugin, Policy, or undeclared binding                     | Inspect the current catalog, load the extension in this process, and match the Policy's `require`. File presence alone does not register it.                                |
| Budget exceeded or request timed out                              | Distinguish operation/evaluator/model counters, wall time, individual request time, full Agent time, and benchmark time. See [limits](configuration.md#limits-and-budgets). |
| Dashboard reports a missing `.rsi` or shows different experiments | Start it from the original experiment workspace and use the same data store.                                                                                                |
| Memory failed or Reflection was rejected                          | Inspect saved reasons and subsequent flow. The experiment can continue with the previous experience or guidance after a learning failure.                                   |
