# Run and inspect experiments

English | [简体中文](running-experiments_zh.md) · [Getting started](../getting-started.md)

This guide explains how to validate, run, inspect, cancel, and resume experiments and troubleshoot them through the CLI and dashboard.

Run commands from the workspace that should own the experiment's `.rsi/` directory. Recipe resource paths resolve against their declaring files; the default data store follows the process's working directory. Separate CLI and dashboard processes observe the same store when launched from the same workspace.

## CLI commands

Use `ember-rsi --help` to list commands and `ember-rsi <command> --help` for a command's syntax. From a source checkout without a global install, use `pnpm ember-rsi`.

| Command                                     | Purpose                                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ember-rsi catalog`                         | List registered plugin and Policy IDs.                                                                                                    |
| `ember-rsi list plugins`                    | Inspect plugin descriptions, contracts, Schemas, and compatible Policy bindings.                                                          |
| `ember-rsi list policies`                   | Inspect Policy descriptions, Schemas, requirements, and compatible plugins.                                                               |
| `ember-rsi doctor <recipe.yaml>`            | Check effective configuration, local resources and runtime prerequisites without running the experiment.                                  |
| `ember-rsi run <recipe.yaml>`               | Start or resume an experiment and persist its records.                                                                                    |
| `ember-rsi list`                            | List saved experiments.                                                                                                                   |
| `ember-rsi show <experiment-id>`            | Print saved experiment status, output, and error information.                                                                             |
| `ember-rsi cancel <experiment-id>`          | Send a cancellation request to the specified experiment.                                                                                  |
| `ember-rsi dashboard`                       | Serve a local web dashboard for inspecting experiments.                                                                                   |
| `ember-rsi reflection list [experiment-id]` | List persisted revisions, optionally for one experiment.                                                                                  |
| `ember-rsi reflection show <revisionID>`    | Inspect revision content and planned resource changes.                                                                                    |
| `ember-rsi reflection apply <revisionID>`   | Write the snapshot to its recorded user-resource paths; see the [Reflection rules](reflection.md#apply-a-revision-to-future-experiments). |
| `ember-rsi help [command]`                  | Show the command list or help for a specific command.                                                                                     |

## CLI parameters

The basic syntax is shown below. Required positional arguments appear in the command table above.

```text
ember-rsi [global options] <command> [arguments] [command options]
```

### Global options

These options apply across commands:

| Option                     | Description                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-h, --help`               | Display help and exit. `ember-rsi --help` lists commands; `ember-rsi <command> --help` shows that command's parameters.                                                                                                                                            |
| `--plugin-dir <directory>` | Load custom plugins and Policies from a directory. Repeat the option for multiple directories; see [plugin registration](writing-plugins.md#step-2-register-the-plugin) and [Policy registration and Recipe configuration](writing-policies.md#register-a-policy). |

### Command-specific options

| Command     | Option                 | Description                                                                           |
| ----------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `run`       | `--id <experiment-id>` | Set the experiment ID. New experiments generate one if omitted; resuming requires it. |
| `run`       | `--resume`             | Resume from saved state; requires `--id`. Omitting it starts a new experiment.        |
| `dashboard` | `--port <port>`        | Set the listening port. Defaults to `4317`; accepts values from `1` to `65535`.       |

## Validate and start

For example, validate and start an experiment with:

```sh
ember-rsi doctor my-experiment/recipe.yaml
ember-rsi run my-experiment/recipe.yaml --id terminal-skills-01
```

- `doctor` checks the Recipe, plugin configuration, contract compatibility, Policy compilation and declared Reflection resources, then calls the optional `doctor` capability on each effective component definition. Its single JSON report contains `recipeId`, `summary`, `checks` and `missingResources`.
  - Statuses are `passed`, `failed` and `unchecked`.
  - For the diagnostic flow, report interpretation, built-in checks and custom-component integration, see the [doctor guide](doctor.md).

Inspect progress from another terminal in the same workspace:

```sh
ember-rsi list
ember-rsi show terminal-skills-01
```

## Read results and evidence

Facts and execution records live in `.rsi/facts/`, immutable artifacts in `.rsi/artifacts/`, and experiment-specific working resources in `.rsi/experiments/<experiment-id>/`.

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

The **Results** view also shows recorded evaluation progress before a final output is available, including status, coverage, and the five most recent evaluations. Follow an evaluation to inspect its measurements and evidence, or open **View all evaluations** for the full history. Intermediate evaluations and different evaluation sets are kept separate from final results; incomplete or failed records do not establish a final score.

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
