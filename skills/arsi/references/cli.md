# CLI and recovery

Read [quickstart](quickstart.md) for setup and runnable resources. Use the installed `arsi` CLI. Run `--help` for version compatibility.

```sh
arsi --help
arsi list plugins
arsi list policies
arsi catalog --plugin-dir .rsi/skill-demo/extension
arsi doctor .rsi/skill-demo/recipe.yaml --plugin-dir .rsi/skill-demo/extension
arsi run .rsi/skill-demo/recipe.yaml --id demo-01 --plugin-dir .rsi/skill-demo/extension
arsi show demo-01
arsi list
arsi cancel demo-01
arsi run .rsi/skill-demo/recipe.yaml --id demo-01 --resume --plugin-dir .rsi/skill-demo/extension
arsi dashboard --port 4317 --plugin-dir .rsi/skill-demo/extension
```

`arsi list plugins` (alias `list plugin`) returns descriptions, contract IDs, input/output/config Schemas and compatible Policy binding slots. `arsi list policies` (alias `list policy`) returns descriptions, Schemas, required contracts, compatible plugins and defaults. Compatibility is structural, not proof of suitability. Bare `arsi list` lists experiments; `arsi catalog` retains compact ID lists.

Choose commands for the current experiment state. All commands accept repeatable `--plugin-dir`. `run` takes a Recipe **path**, not catalog ID. `--resume` requires `--id`. Data is `.rsi/` under the current working directory; inspect and retry from that same directory. There are no `--data-dir`, `--json`, `--recipe`, `--request-id`, pause, continue or detach options.

Output is JSON for ordinary commands, not a versioned CLI envelope. Exit 0 means the command returned normally; inspect the experiment's status separately. Errors return 1 and interruption returns 130. `dashboard` requires a `.rsi` directory in the current working directory, prints its address, and keeps running. For clean machine stdout invoke the supplied binary or `node dist/src/entries/cli/main.js` in a checkout, avoiding package-manager banners.

`doctor` validates the Recipe and dispatches `rsi/doctor` for each effective binding whose plugin subscribed, including Reflection. Its single JSON report contains `recipeId`, `summary`, `checks` and `missingResources`. A check is `passed`, `failed` or `unchecked` with its scope and reason. Missing resources list dependent unchecked IDs in `checksNotRun`. Exit 1 means at least one failed check; exit 0 can include unchecked checks, including custom plugins without a diagnostic handler. Registration or loading failures report `recipeId: null`. RSI uses isolated temporary storage; Evaluators delegate to the full SDK doctor and its native download/build probes and time limits. Doctor does not execute Agents, request model inference or record optimization experiments. A passing report does not establish benchmark success. `run` never requires or consumes this report.

The process running the experiment owns execution. Cancellation is a request: observe terminal state and released instances afterward. Do not cancel a terminal experiment; it has no active work, and this supported revision has a known unhandled rejection risk on the HTTP cancel route for terminal IDs.

## Resume an existing experiment

Use `--resume --id <experiment-id>` with the current Recipe from the original working directory. Runtime compares the ordered Policy step IDs, types, nesting, and required contract IDs. A compatible Recipe can replace plugin implementations, model endpoints, configuration, and code. Runtime reuses completed-step outputs and committed calls, then executes unfinished steps with the supplied configuration.

Failed, cancelled, and interrupted experiments use the same resume entrypoint. A succeeded experiment returns its existing record without executing again, as verified by `run.mjs`. Keep the persisted store and required resources. Resume can retry calls with unknown outcomes and archives unresolved cleanup from the previous attempt. External operations with unknown outcomes may run again.

After abrupt process death, the experiment lock may remain temporarily. The Runtime refreshes it every 10 seconds and considers it stale after 60 seconds. Confirm the previous owner has exited, allow the stale interval to pass with a small margin, then retry. A lock error before execution may leave the persisted experiment status as `running`. Inspect the error and new execution evidence.

Retry retains usage and the original start time, including downtime. Increase an exhausted budget in the Recipe when further execution is intended. Forced process termination can prevent `finally` and `dispose` from running.
