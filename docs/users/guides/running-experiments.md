# Run and inspect experiments

English | [简体中文](running-experiments_zh.md) · [Getting started](../getting-started.md)

This guide explains how to validate, run, inspect, cancel, and resume experiments and troubleshoot them through the CLI and dashboard.

Run commands from the workspace that should own the experiment's `.rsi/` directory. Recipe resource paths resolve against their declaring files; the default data store follows the process's working directory. Separate CLI and dashboard processes observe the same store when launched from the same workspace.

## CLI commands

Use `ember-rsi --help` or `<command> --help` for the installed build's syntax. From a source checkout without a global install, use `pnpm ember-rsi`.

| Command                                                     | Purpose                                                                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ember-rsi catalog`                                         | List registered plugin and Policy IDs.                                                                                                    |
| `ember-rsi list plugins`                                    | Inspect plugin descriptions, contracts, Schemas, and compatible Policy bindings.                                                          |
| `ember-rsi list policies`                                   | Inspect Policy descriptions, Schemas, requirements, and compatible plugins.                                                               |
| `ember-rsi validate <recipe.yaml>`                          | Validate configuration and wiring without running the experiment.                                                                         |
| `ember-rsi run <recipe.yaml> --id <experiment-id>`          | Start a real experiment and persist its records.                                                                                          |
| `ember-rsi list`                                            | List saved experiments.                                                                                                                   |
| `ember-rsi show <experiment-id>`                            | Print saved experiment status, output, and error information.                                                                             |
| `ember-rsi cancel <experiment-id>`                          | Persist a cancellation request.                                                                                                           |
| `ember-rsi run <recipe.yaml> --id <experiment-id> --resume` | Recover the identified experiment from its saved state.                                                                                   |
| `ember-rsi dashboard --port 4317`                           | Serve the built observation UI on loopback; requires an existing `.rsi/` directory.                                                       |
| `ember-rsi reflection list [experiment-id]`                 | List persisted revisions, optionally for one experiment.                                                                                  |
| `ember-rsi reflection show <revisionID>`                    | Inspect revision content and planned resource changes.                                                                                    |
| `ember-rsi reflection apply <revisionID>`                   | Write the snapshot to its recorded user-resource paths; see the [Reflection rules](reflection.md#apply-a-revision-to-future-experiments). |

`--plugin-dir <directory>` is repeatable. Pass the same extensions when validating, running, resuming, or observing a custom setup. Default extensions load from `~/.ember-rsi/plugins/<name>/index.mjs` before explicit directories. See [extension registration](writing-plugins.md#register-an-external-extension-for-the-cli).

## Validate and start

For the tutorial Recipe:

```sh
ember-rsi validate my-experiment/recipe.yaml
ember-rsi run my-experiment/recipe.yaml --id terminal-skills-01
```

`validate` checks the Recipe, plugin configuration, contract compatibility, Policy compilation, and declared Reflection resources. It does not initialize the Bundle, load benchmark images, launch Python/remote inference, check credentials, or call a model. Prepare those prerequisites before running. `run` makes actual external calls and can consume model and compute resources.

Inspect progress from another terminal in the same workspace:

```sh
ember-rsi list
ember-rsi show terminal-skills-01
```

`show` prints the saved experiment record, rather than a live percentage-complete estimate. The dashboard exposes recorded calls, candidate lineage, measurements, and traces for more detailed inspection. A long-running evaluator call can remain in progress until its configured benchmark timeout; model requests and complete Agent calls have separate limits.

## Read results and evidence

Check three levels separately:

1. **Experiment status.** `succeeded`, `failed`, or `cancelled` describes the recorded execution outcome. A completed Policy does not establish a score improvement.
2. **Measurement validity.** Confirm technical status, coverage, task IDs, candidate references, metric definitions, and comparison conditions. A zero score with complete successful execution differs from setup failure, partial coverage, or a missing metric. Metric selection requires compatible measurements.
3. **Selected output.** Follow the Policy's result references. WikiSkill returns `candidateRef`, validation `measurementRef`, `memoryRef`, and optional `testMeasurementRef`. Harness² returns the baseline and selected `deliveries` for its tasks. Inspect the referenced files and evidence before reusing a candidate.

Facts and receipts live in `.rsi/facts/`, immutable artifacts in `.rsi/artifacts/`, and experiment-specific working resources in `.rsi/experiments/<experiment-id>/`. Preserve the store and original resource files for recovery. Use management/query APIs or the dashboard to inspect records; do not edit facts to manufacture a status or resume point.

Memory and Reflection changes require actual later consumption: storing Memory does not make every plugin read it, and activating guidance does not by itself prove a model used it. Verify later execution in the same unfinished experiment when assessing an online change. Test measurements remain final reporting input according to the Policy's task split, rather than learning evidence.

## Cancellation and resume

```sh
ember-rsi cancel terminal-skills-01
ember-rsi show terminal-skills-01
```

Cancellation is a request, not proof that all work has already stopped. The active Runtime propagates its cancellation signal and cleans up owned resources. Inspect the final status and cleanup records. Ctrl+C also signals cancellation to the launching CLI.

To resume, use the same workspace, original Recipe path, experiment ID, and required extensions:

```sh
ember-rsi run my-experiment/recipe.yaml --id terminal-skills-01 --resume
```

The Runtime restores locked definitions, budget usage, effective revisions, call receipts, and checkpoints, and rejects incompatible changes. Resume does not reset counters or the experiment's start time; a configured elapsed-wall budget includes downtime. Preserve the implementation and resources used by an unfinished run. Use a new experiment ID for a deliberately changed setup.

Successful receipts and completed steps can be reused. A settled failed or cancelled call may be retried only when the plugin's `canRetry` confirms that replay cannot duplicate effects; unknown or still-running external outcomes require reconciliation. Resume is not a guarantee of exactly-once external execution. Cleanup failures are tracked separately; embedded hosts have explicit [cleanup reconciliation](writing-plugins.md#embed-the-runtime).

Memory update failures retain the prior `memoryRef` (including an initial null), with a failed receipt and no change reference. Reflection update failures retain the effective guidance and record rejection. These learning failures alone do not cancel the experiment. User cancellation, total experiment budget exhaustion, and critical Runtime persistence failures still stop execution. A persisted completed failed Memory result is reused at that boundary on resume.

## Dashboard

```sh
ember-rsi dashboard --port 4317
```

Run from an experiment workspace that already contains `.rsi/`, then open the printed address. The UI displays experiments, summaries, candidates, diffs, measurements, calls, Agent traces, results, and charts. Start, resume, and cancel experiments through the CLI. Saved traces can be incomplete or unavailable; missing data is not evidence that no call occurred.

The **Reflection & Memory** tab in experiment details lets you inspect learning:

- **Reflection**: Inspect plugin revisions, statuses, reasons, and contents. Use `Changes` or `Full contents` to compare changes or read the full text.
- **Memory**: Inspect experience updates, statuses, reasons, and documents. Use `View call` to open the corresponding call.
- **Apply Reflection changes**: Select a revision, click `Preview application`, review the source files it would create, replace, or delete, then confirm and click `Apply changes`. This writes the original user resources for future experiments. The same scope and blocking rules apply as for the CLI; see [Apply a revision to future experiments](reflection.md#apply-a-revision-to-future-experiments).

`dashboard` serves built assets. After source changes, run `pnpm build`. For UI development, `pnpm dev:web` starts Vite and proxies `/api` to port 4317 by default; start the backend separately. The dashboard listens on loopback and checks Host/Origin. It does not provide public-deployment user authentication.

## Troubleshooting

| Symptom                                                           | Check                                                                                                                                                                        |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recipe rejects `ref` or a Policy rejects `finish`                 | Use `application.plugin`, `policy.id`, binding `plugin`, and ordered typed `steps`; see [configuration](configuration.md) and [Policy syntax](writing-policies.md).          |
| Unknown plugin, Policy, or undeclared binding                     | Inspect the current catalog, load the extension in this process, and match the Policy's `require`. File presence alone does not register it.                                 |
| Validation passes but execution fails                             | Check the Bundle/Target, benchmark assets, Docker context and capacity, model access from host and containers, or inference/Python prerequisites. Preserve the native error. |
| Budget exceeded or request timed out                              | Distinguish operation/evaluator/model counters, wall time, individual request time, full Agent time, and benchmark time. See [limits](configuration.md#limits-and-budgets).  |
| Selector refuses a comparison                                     | Check complete successful coverage, matching metric definitions and comparison conditions; do not rename a missing metric to force selection.                                |
| Dashboard reports a missing `.rsi` or shows different experiments | Start it from the original experiment workspace and use the same data store. Rebuild if only the API-ready message appears.                                                  |
| Resume fails after editing configuration/resources                | Restore the compatible setup or start a new experiment. Inspect receipts before repeating an external effect with an unknown outcome.                                        |
| Memory failed or Reflection was rejected                          | Inspect saved reasons and subsequent flow. The previous experience/guidance can remain effective; failure is distinct from a normal no-change result.                        |
