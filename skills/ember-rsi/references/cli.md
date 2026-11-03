# CLI and recovery

Read [quickstart](quickstart.md) for setup and runnable resources. Use the installed `ember-rsi` CLI. Run `--help` for version compatibility.

```sh
ember-rsi --help
ember-rsi list plugins
ember-rsi list policies
ember-rsi catalog --plugin-dir .rsi/skill-demo/extension
ember-rsi validate .rsi/skill-demo/recipe.yaml --plugin-dir .rsi/skill-demo/extension
ember-rsi run .rsi/skill-demo/recipe.yaml --id demo-01 --plugin-dir .rsi/skill-demo/extension
ember-rsi show demo-01
ember-rsi list
ember-rsi cancel demo-01
ember-rsi run .rsi/skill-demo/recipe.yaml --id demo-01 --resume --plugin-dir .rsi/skill-demo/extension
ember-rsi serve --port 4317 --plugin-dir .rsi/skill-demo/extension
```

`ember-rsi list plugins` (alias `list plugin`) returns descriptions, contract IDs, input/output/config Schemas and compatible Policy binding slots. `ember-rsi list policies` (alias `list policy`) returns descriptions, Schemas, required contracts, compatible plugins and defaults. Compatibility is structural, not proof of suitability. Bare `ember-rsi list` lists experiments; `ember-rsi catalog` retains compact ID lists.

These are command shapes, not a sequence to cancel and resume an already successful demo. All commands accept repeatable `--plugin-dir`. `run` takes a Recipe **path**, not catalog ID. `--resume` requires `--id`. Data is `.rsi/` under the current working directory; inspect and resume from that same directory. There are no `--data-dir`, `--json`, `--recipe`, `--request-id`, pause, continue or detach options.

Output is JSON for ordinary commands, not a versioned CLI envelope. Exit 0 means the command returned normally; inspect the experiment's status separately. Errors return 1 and interruption returns 130. `serve` prints its address and keeps running. For clean machine stdout invoke the supplied binary or `node dist/src/entries/cli/main.js` in a checkout, avoiding package-manager banners.

The process running the experiment owns execution. Cancellation is a request: observe terminal state and released instances afterward. Do not cancel a terminal experiment; it has no active work, and this supported revision has a known unhandled rejection risk on the HTTP cancel route for terminal IDs.

## Resume without corrupting history

Keep original Recipe, resources, extension implementation and dependency versions. Inspect failed call receipts and owned external resources before resuming. A checkpoint can replay completed calls and continue at a safe boundary; an unconfirmed/failed effect can deliberately block recovery. Do not edit receipts/facts, widen budgets or change configuration to force resume. Reconcile the external effect first; if safe recovery is unsupported, report the blocker and create a new explicitly scoped stage.

After abrupt process death, the experiment lock may remain temporarily. The current Runtime refreshes it every 10 seconds and considers it stale after 60 seconds. Confirm the previous owner has exited, allow the stale interval to pass with a small margin, then retry resume with the same configuration. Do not delete a lock to bypass a live owner. A lock error before execution may leave the persisted experiment status as `running`; that status alone does not establish that recovery started. Inspect the thrown error and the new execution evidence. Waiting for a stale lock does not resolve uncertain call receipts.

Elapsed time retains its original start, including downtime. Resuming a succeeded experiment returns its existing record without executing again (covered by `run.mjs`). Changed goals/configuration require a new ID and explicit artifact handoff. A completed result does not independently establish cleanup success.

Forced process termination cannot run `finally` or `dispose`. After interruption, inspect actual instance/resource state and receipts before resuming; callback execution alone is not cleanup evidence.
