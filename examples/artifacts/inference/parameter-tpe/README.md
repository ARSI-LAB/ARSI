# Remote vLLM parameter TPE

[recipe.yaml](recipe.yaml) uses `policy.parameter-optuna` with `proposer.optuna`
and `sampler.type: tpe`. It uses the target, baseline and remote lifecycle template in `../shared/`
through recipe-relative paths, as does the [grid example](../parameter-grid/README.md).
Keep this recipe directory and `shared/` together when copying the example.
Implement that template and configure the endpoint, model, credentials and
tokenizer as described in the grid example before running.

The search samples `max_num_seqs` from 32 through 64 in steps of 8 and
`max_num_batched_tokens` from 1024 or 2048. The calibration upper corner stays
64 / 2048. The AgentX workload, latency constraint and four-evaluation budget
match the grid example. Two completed startup trials allow TPE to use measured
feedback within this small budget; this is a configuration example, not evidence
of convergence or performance improvement. Duplicate suggestions are skipped.
The baseline is not automatically evaluated unless sampled.

## Python setup

On the RSI control machine, use Python 3.10–3.13 and install the pinned worker
dependencies. From the repository root:

```sh
python3.11 -m venv .scratch/optuna-venv
.scratch/optuna-venv/bin/python -m pip install -r src/plugins/proposer-optuna/python/requirements.txt
```

Set `bindings.proposer.config.python.executable` in this recipe to the absolute
path of that environment's Python interpreter. The Application's
`remote.executable` is configured separately. For an installed package, the worker
dependencies are listed in
`node_modules/ember-rsi/dist/src/plugins/proposer-optuna/python/requirements.txt`.
See [limits and budgets](../../../../docs/users/guides/configuration.md#limits-and-budgets)
and [stateful search](../../../../docs/users/guides/writing-plugins.md#stateful-search)
for sampling limits and recovery.
Validation checks schemas without starting Python or the remote server.

## Run

After building RSI and configuring deployment:

```sh
ember-rsi doctor examples/artifacts/inference/parameter-tpe/recipe.yaml
ember-rsi run examples/artifacts/inference/parameter-tpe/recipe.yaml --id parameter-tpe-first
ember-rsi show parameter-tpe-first
ember-rsi run examples/artifacts/inference/parameter-tpe/recipe.yaml --id parameter-tpe-first --resume
```

Resume requires the same locked configuration and reconciliation of any unknown
remote lifecycle outcome. The supplied deployment script is a template that
raises `NotImplementedError` until implemented; no real evaluation is performed
by validation.
