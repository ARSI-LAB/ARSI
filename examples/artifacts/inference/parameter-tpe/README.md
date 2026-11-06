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
`remote.executable` is configured separately. For an installed package, the
dependency file is `node_modules/ember-rsi/dist/src/plugins/proposer-optuna/python/requirements.txt`.
`python.timeoutMs` limits each worker call. Search initialization checks the
interpreter and pinned Optuna/NumPy versions before the first evaluation.
Validation checks schemas without starting Python or the remote server.

## Search configuration

Configure the search under `bindings.proposer.config`. `path` selects the
candidate's parameter JSON file, and `searchSpace` lists the parameters to tune:

| `distribution` | Fields                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `categorical`  | `values`: unique numbers, strings, booleans, or `null`. Arrays, objects, and choices Python treats as equal, such as `[true, 1]`, are rejected. |
| `int`          | Inclusive safe-integer bounds `low` and `high`; `step` defaults to 1.                                                                           |
| `float`        | Inclusive finite bounds `low` and `high`; optional `step`.                                                                                      |

Stepped bounds must align. `log: true` requires positive bounds; logarithmic
integers use step 1, and logarithmic floats cannot specify a step. Other fields
are defined by the [Proposer configuration Schema](../../../../src/plugins/proposer-optuna/schema.ts).

TPE's `startupTrials` defaults to 10; keep it below `policy.config.maxTrials` to
allow evaluations after the startup phase. This recipe uses 2 startup trials
within 4 evaluations. TPE also accepts `eiCandidates` and `multivariate` options.
To use random sampling instead, replace these fields in the Proposer config:

```yaml
sampler:
  type: random
  seed: 42
  options: {}
constraintHandling: selection-only
```

The Selector defines the objective metric, direction, and constraints. TPE's
`native` mode also uses those constraints during sampling; `selection-only`
leaves sampling unconstrained while the Selector still rejects infeasible
results. Random sampling requires `selection-only`. Every complete evaluation
is feedback, including rejected configurations and constraint violations;
deployment failures and incomplete evaluations are errors rather than low scores.

`policy.config.maxTrials` limits new evaluations: default 50, maximum 1,000.
Allow enough `budget.evaluationRuns` and `budget.operations` for the planned
trials. Optional `maxSamplingAttempts` caps all sampling attempts, including
duplicate combinations that skip evaluation; it has no separate limit when
omitted. Sampling and duplicate attempts also consume any configured wall-time
budget. See [limits and budgets](../../../../docs/users/guides/configuration.md#limits-and-budgets).

## Run

After building RSI and configuring deployment:

```sh
ember-rsi validate examples/artifacts/inference/parameter-tpe/recipe.yaml
ember-rsi run examples/artifacts/inference/parameter-tpe/recipe.yaml --id parameter-tpe-first
ember-rsi show parameter-tpe-first
ember-rsi run examples/artifacts/inference/parameter-tpe/recipe.yaml --id parameter-tpe-first --resume
```

Resume requires the same locked configuration and reconciliation of any unknown
remote lifecycle outcome. The supplied deployment script is a template that
raises `NotImplementedError` until implemented; no real evaluation is performed
by validation.

## Results

The Policy takes `candidateRef` as input, defaulting to the Application's initial
candidate. `ember-rsi show <experiment-id>` includes the Policy output after a
normal finish:

| Field                            | Meaning                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                         | `selected` when a configuration satisfies the constraints; `no-feasible-configuration` when none does.                                                                                            |
| `candidateRef`, `measurementRef` | The selected configuration and its measurement; both are `null` when no feasible result exists.                                                                                                   |
| `parameters`                     | The selected search parameters and values, or `null` when no feasible result exists.                                                                                                              |
| `measurementRefs`                | All measurement references recorded by the search.                                                                                                                                                |
| `stopReason`                     | `max-trials` at the evaluation limit, `search-exhausted` when a finite space is exhausted, or `sampling-limit` at the sampling attempt limit. The last reason does not imply exhaustive coverage. |
| `searchStateRef`                 | Reference to the saved search state, used to continue the same search on resume.                                                                                                                  |

The result is the best feasible configuration among those evaluated. Remeasure
the baseline and selected configuration under the same workload to assess
improvement. See the [result Schema](../../../../src/policies/parameter-optuna/schemas/result.yaml)
for field definitions and [cancellation and resume](../../../../docs/users/guides/running-experiments.md#cancellation-and-resume)
for recovery. Resume uses the original Recipe, experiment ID, and environment;
start a new experiment for intentional configuration changes.
