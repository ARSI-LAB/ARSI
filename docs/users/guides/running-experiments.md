# Run and inspect experiments

English | [简体中文](running-experiments_zh.md) · [Getting started](../getting-started.md)

This guide explains how to validate, run, inspect, cancel, and retry experiments through the CLI and dashboard.

Run commands from the workspace that should own the experiment's `.rsi/` directory. Recipe resource paths resolve against their declaring files; the default data store follows the process's working directory. Separate CLI and dashboard processes observe the same store when launched from the same workspace.

## CLI commands

Use `arsi --help` to list commands and `arsi <command> --help` for a command's syntax. From a source checkout without a global install, use `pnpm arsi`.

| Command                                | Purpose                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `arsi catalog`                         | List registered plugin and Policy IDs.                                                                                                    |
| `arsi list plugins`                    | Inspect plugin descriptions, contracts, Schemas, and compatible Policy bindings.                                                          |
| `arsi list policies`                   | Inspect Policy descriptions, Schemas, requirements, and compatible plugins.                                                               |
| `arsi doctor <recipe.yaml>`            | Check effective configuration, local resources and runtime prerequisites without running the experiment.                                  |
| `arsi run <recipe.yaml>`               | Start or resume an experiment and persist its records.                                                                                    |
| `arsi list`                            | List saved experiments.                                                                                                                   |
| `arsi show <experiment-id>`            | Print saved experiment status, output, and error information.                                                                             |
| `arsi cancel <experiment-id>`          | Send a cancellation request to the specified experiment.                                                                                  |
| `arsi cleanup [experiment-id]`         | [Preview or release experiment resources](#clean-up-experiment-resources).                                                                |
| `arsi dashboard`                       | Serve a local web dashboard for inspecting experiments.                                                                                   |
| `arsi reflection list [experiment-id]` | List persisted revisions, optionally for one experiment.                                                                                  |
| `arsi reflection show <revisionID>`    | Inspect revision content and planned resource changes.                                                                                    |
| `arsi reflection apply <revisionID>`   | Write the snapshot to its recorded user-resource paths; see the [Reflection rules](reflection.md#apply-a-revision-to-future-experiments). |
| `arsi help [command]`                  | Show the command list or help for a specific command.                                                                                     |

## CLI parameters

The basic syntax is shown below. Required positional arguments appear in the command table above.

```text
arsi [global options] <command> [arguments] [command options]
```

### Global options

These options apply across commands:

| Option                     | Description                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-h, --help`               | Display help and exit. `arsi --help` lists commands; `arsi <command> --help` shows that command's parameters.                                                                                                                                                      |
| `--plugin-dir <directory>` | Load custom plugins and Policies from a directory. Repeat the option for multiple directories; see [plugin registration](writing-plugins.md#step-2-register-the-plugin) and [Policy registration and Recipe configuration](writing-policies.md#register-a-policy). |

### Command-specific options

| Command     | Option                 | Description                                                                           |
| ----------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `run`       | `--id <experiment-id>` | Set the experiment ID. New experiments generate one if omitted; resuming requires it. |
| `run`       | `--resume`             | Continue an existing experiment with the supplied Recipe. Requires `--id`.            |
| `doctor` | `--static` | Check configuration and declared local paths only, skipping component diagnostics. |
| `cleanup` | `--all` | Clean up all experiments in this workspace, skipping any in use. Cannot be combined with an experiment ID. |
| `cleanup` | `--dry-run` | Preview eligible resources and reasons for retaining others. |
| `run` / `doctor` / `cleanup` | `--progress` / `--no-progress` | Enable or disable live progress and the summary on stderr. Interactive terminals enable progress by default. |
| `run` / `doctor` / `cleanup` | `--progress-mode <mode>` | Choose the progress renderer: `auto` (default), `tty` (in-place status bar), or `plain` (append-only lines for CI/logs). |
| `run` / `doctor` / `cleanup` | `-v, --verbose` | Include Policy steps/nested calls (`run`), every individual check (`doctor`), or bindings and individual receipts (`cleanup`). |
| `run` / `doctor` / `cleanup` | `-q, --quiet` | Suppress live progress output on stderr. |
| `dashboard` | `--port <port>`        | Set the listening port. Defaults to `4317`; accepts values from `1` to `65535`.       |

## Validate and start

For example, validate and start an experiment with:

```sh
arsi doctor my-experiment/recipe.yaml
arsi run my-experiment/recipe.yaml --id terminal-skills-01 --progress
```

- `doctor` checks the Recipe, plugin configuration, contract compatibility, Policy compilation and declared Reflection resources, then dispatches `rsi/doctor` to bindings with valid local paths and a handler. Its single JSON report contains `recipeId`, `summary`, `checks` and `missingResources`.
  - Statuses are `passed`, `failed` and `unchecked`.
  - For the diagnostic flow, report interpretation, built-in checks and custom-component integration, see the [doctor guide](doctor.md).

In interactive terminals (`stderr` is a TTY and neither `CI` nor `TERM=dumb` is set), `arsi run` automatically renders completed milestones (including key outcomes such as measurement metrics, selector decisions, proposals, revision activations, and resumed call summaries) above an in-place sticky status area on stderr (showing live Evaluator task progress, active Agent turns/tools, and resource cleanup while respecting `NO_COLOR`), avoiding scrollback spam while keeping stdout reserved for the JSON experiment record on success. In non-TTY environments, pass `--progress` (or `--progress-mode plain`) for append-only plain-text progress, `-v`/`--verbose` to include Policy steps and nested calls, or `-q`/`--quiet` (`--no-progress`) to silence stderr progress. The final summary includes the experiment status, stop reason, usage, and available result references.

When the SDK reports a failure, Evaluator progress shows its registered error code and any confirmed cause. If the cause is unavailable, it displays the registered hint and points to any saved diagnostics. Use `--verbose` to see the phase and any available HTTP status, process exit code, and attempt ID.

Inspect saved status from another terminal in the same workspace:

```sh
arsi list
arsi show terminal-skills-01
```

## Read results and evidence

Facts and execution records live in `.rsi/facts/`, immutable artifacts in `.rsi/artifacts/`, and experiment-specific working resources in `.rsi/experiments/<experiment-id>/`.

- Preserve the store and supply a valid Recipe and its referenced resources when retrying.

## Cancellation and resume

```sh
arsi cancel terminal-skills-01
arsi show terminal-skills-01
```

A cancellation request does not stop all work immediately. Runtime propagates the cancellation signal and cleans up its own resources. Check the final status and cleanup records.

- Press Ctrl+C once to request cancellation and let the CLI clean up. Press it again while the CLI is still running to force it to exit.

To continue a failed, cancelled, or interrupted experiment, use the same workspace, experiment ID, and required extensions. Supply the current Recipe.

```sh
arsi run my-experiment/recipe.yaml --id terminal-skills-01 --resume
```

Runtime restores budget usage, compatible effective revisions, call receipts, and checkpoints. It checks the supplied Policy shape before executing unfinished steps.

Experiments created before the Runtime saved control-flow decisions require a new experiment ID.

- Resuming a successful experiment returns the saved result with its original usage.
- Keep the ordered Policy step IDs, types, nesting, and required plugin contract IDs. New calls use the currently registered input and output schemas.
- The Runtime reuses completed Policy steps and committed results. It retries unfinished steps using the supplied bindings, configuration, and code. For an in-progress branch, loop iteration, or foreach, it preserves the previously selected branch, iteration, or items. A retried plugin call uses a fresh attempt directory and acquires fresh instances.
- Retry keeps recorded usage and the original start time. Update the Recipe budget if the experiment exhausted it.
- Once the previous execution releases the experiment lock or the lock expires after a crash, resume can retry incomplete calls, including receipts marked `unknown` or left as `running`. The Runtime archives the previous receipt and any unresolved cleanup record. A retry can repeat an external operation whose previous outcome is unknown.

## Clean up experiment resources

RSI retains reusable resources after every run. When you request cleanup, RSI collects bindings from the current and archived Recipes and creates a temporary instance for each distinct `(bindingId, pluginId)` using its most recently saved configuration. Bindings skipped during execution are included. AgentBench and OperatorBench can release eligible SDK resources.

- `arsi cleanup` or `arsi cleanup --dry-run` previews eligible resources in the current `.rsi` workspace.
- `arsi cleanup terminal-skills-01 --dry-run` previews one experiment. Run `arsi cleanup terminal-skills-01` to release its eligible resources.
- `arsi cleanup --all` releases eligible resources across the workspace and skips experiments in use.

For custom plugins, pass the same `--plugin-dir` used to run the experiment. A missing plugin or a failed instance initialization is reported as `pending` and other bindings are still checked. Evaluator cleanup uses `EVALUATOR_NETWORK_CONFIG` or `~/.arsi-evaluator/network.yaml`. If the file is missing, the receipt stays `pending`. Restore the configuration and retry.

Cleanup preserves checkpoints, results, logs, and resources still in use by other experiments. A later `--resume` or another experiment of the same type may take longer to start if it needs to pull or rebuild images.

In interactive terminals, `arsi cleanup` automatically renders per-binding (single experiment) or per-experiment (workspace) milestones above an in-place status area on stderr (including active bindings and Evaluator receipt progress), while keeping stdout reserved for the JSON cleanup report. Pass `--progress` or `--progress-mode plain` in non-TTY environments, `-v`/`--verbose` for binding and receipt details, or `-q`/`--quiet` (`--no-progress`) to suppress stderr progress.

## Dashboard

```sh
arsi dashboard --port <port>
```

Run from an experiment workspace that already contains `.rsi/`. The web dashboard displays experiments, summaries, candidates, diffs, measurements, calls, Agent traces, results, and charts, as shown below.

Measurement details show each recorded item's full identifier, subject kind, status, coverage, and metrics. Failed, cancelled, and unknown items show no valid score rather than a numeric result. Missing item evidence is reported explicitly; a successful zero score remains zero.
Metrics that share a display label include their recorded metric names so distinct values remain identifiable.

- Start, resume, and cancel experiments through the CLI.
- Harness results include a Delivered column linked to the measurement returned by the saved selection, with its stage, status, and coverage. Its average uses only available scores from recorded deliveries; unselected higher scores are not substituted, and missing selections show “Not recorded”.
- The development frontend proxies `/api` to port 4317 by default.
- Results for Policies without a specialized report include recorded evaluations before a final output is available, and retain the evaluation history after completion. Final candidates still come only from saved output references. Evaluation lists show status and coverage; failed or interrupted measurements do not supply a final score.
- Results also display the experiment's recorded error when execution fails. An experiment that has ended without a final output is shown as having no recorded final result, while its evaluations remain available.

![rsi-studio-wikiskill-compact](../assets/rsi-studio-wikiskill-compact.gif)

## Troubleshooting

| Symptom                                                           | Check                                                                                                                                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown plugin, Policy, or undeclared binding                     | Inspect the current catalog, load the extension in this process, and match the Policy's `require`. File presence alone does not register it.                                |
| Budget exceeded or request timed out                              | Distinguish operation/evaluator/model counters, wall time, individual request time, full Agent time, and benchmark time. See [limits](configuration.md#limits-and-budgets). |
| Dashboard reports a missing `.rsi` or shows different experiments | Start it from the original experiment workspace and use the same data store.                                                                                                |
| Memory failed or Reflection was rejected                          | Inspect saved reasons and subsequent flow. The experiment can continue with the previous experience or guidance after a learning failure.                                   |
