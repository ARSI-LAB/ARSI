# Inference parameter search

English | [简体中文](../zh-CN/parameter-search.md) · [User guide](guide.md)

Choose one Policy per experiment. Both use `application.inference`, `evaluator.inferencebench`, and `selector.metric`:

| Policy                    | Proposer          | Search                                    | Python required |
| ------------------------- | ----------------- | ----------------------------------------- | --------------- |
| `policy.parameter-grid`   | `proposer.grid`   | Enumerate explicit JSON parameter choices | No              |
| `policy.parameter-optuna` | `proposer.optuna` | Optuna TPE or random sampling             | Yes             |

The former `policy.vllm-autotune` ID has been removed. Update Recipes to `policy.parameter-grid`. Saved experiments referencing the old Policy are not automatically migrated for resume. The [vLLM inference example](../../../examples/artifacts/inference/parameter-grid/README.md) remains the starting point for Application, remote startup, workload, metrics, and budget configuration.

A complete [TPE recipe example](../../../examples/artifacts/inference/parameter-tpe/README.md) uses the common deployment assets in `shared/` and uses two startup trials within a four-evaluation budget.

## Install Python for Optuna

Use Python 3.10–3.13 on the RSI control machine. Create an environment and install the pinned algorithm dependencies:

```sh
python3.11 -m venv .scratch/optuna-venv
.scratch/optuna-venv/bin/python -m pip install -r src/plugins/proposer-optuna/python/requirements.txt
.scratch/optuna-venv/bin/python -B tests/integration/optuna-worker.py
RSI_OPTUNA_PYTHON="$PWD/.scratch/optuna-venv/bin/python" node --import tsx --test tests/integration/optuna-worker.test.ts
```

For an installed package, use `node_modules/ember-rsi/dist/src/plugins/proposer-optuna/python/requirements.txt`. Set `python.executable` to your environment's interpreter. An executable containing `/` should be an absolute path; bare executable names resolve through PATH. Set `python.timeoutMs` to limit each worker invocation. RSI does not install Python dependencies automatically. Catalog/Recipe schema validation does not launch Python; initialization checks the interpreter and pinned Optuna/NumPy versions before the first evaluation.

The Python test command explicitly runs real Optuna against synthetic inputs, including historical replay. The Node.js test checks real worker output against TypeScript parameter validation. Default `pnpm check` uses local deterministic tests without requiring Python. To exercise the packaged Python worker outside the checkout, set `RSI_OPTUNA_PYTHON` when running `pnpm check:package`.

## Configure the search

Starting from the inference example, replace its `policy` and `bindings.proposer` sections with the following fragment. Retain its Application, Evaluator, Selector, and budget sections, increasing evaluation and operation limits for the requested trials:

```yaml
policy:
  id: policy.parameter-optuna
  config:
    maxTrials: 50
bindings:
  proposer:
    plugin: proposer.optuna
    config:
      path: tuning.json
      python:
        executable: /absolute/path/to/venv/bin/python
        timeoutMs: 30000
      sampler:
        type: tpe
        seed: 42
        options:
          startupTrials: 10
          eiCandidates: 24
          multivariate: false
      constraintHandling: native
      maxSamplingAttempts: 1000
      searchSpace:
        - name: max_num_seqs
          distribution: int
          low: 16
          high: 128
          step: 16
        - name: max_num_batched_tokens
          distribution: categorical
          values: [1024, 2048, 4096, 8192]
```

Users define the search space and verify engine compatibility. `path` identifies one editable JSON object file; names are top-level keys, and untuned fields retain their baseline values. Application still enforces the Target and candidate validity. Do not search a parameter that Application calibration independently overrides, such as `gpu_memory_utilization` when automatic memory calibration is enabled.

| Distribution  | Required fields                              | Optional fields                           |
| ------------- | -------------------------------------------- | ----------------------------------------- |
| `categorical` | `values`: unique JSON scalar choices         | None                                      |
| `int`         | `low`, `high`: inclusive safe-integer bounds | `step` (default 1), `log` (default false) |
| `float`       | `low`, `high`: inclusive finite bounds       | `step`, `log` (default false)             |

Stepped bounds must align. Log sampling requires positive bounds; logarithmic integers use step 1, and logarithmic floats cannot specify step. Optuna categorical choices cannot be arrays/objects, and ambiguous boolean/number choices such as `[true, 1]` are rejected. Native grid continues to support arbitrary JSON choices. Engine-specific cross-parameter validation and analytical hardware feasibility are not added by this optimizer.

For random search, replace the sampler and constraint mode:

```yaml
sampler:
  type: random
  seed: 42
  options: {}
constraintHandling: selection-only
```

TPE accepts only `startupTrials`, `eiCandidates`, and `multivariate` in `options`; random accepts no options. TPE defaults to ten completed startup trials, 24 EI candidates, and independent parameter modeling. A trial limit at or below the startup threshold may never use adaptive TPE. GP, CMA-ES, QMC, multi-objective optimization, conditional search spaces, and arbitrary Python callbacks are not supported in this release.

## Feedback, limits, and recovery

Selector configuration remains the sole definition of objective, direction, workload point/statistic, and SLO constraints. TPE's `native` mode uses those constraints for sampling; `selection-only` leaves sampling unconstrained while Selector still excludes infeasible candidates from delivery. Random requires `selection-only`.

Every complete evaluation is fed back, including rejected candidates and SLO violations. A failed/incomplete evaluation, invalid metric, deployment failure, or cancellation is not converted into a low score. The existing Runtime failure and cleanup behavior applies.

The proposer implements `initialize`, `suggest`, and `observe` through [contract.proposer-parameter-search](../../../src/contracts/plugin-types/proposer-parameter-search.ts). It stores immutable search states in `.rsi/artifacts/`; Policy checkpoints hold the latest `stateRef`. Python reconstructs the Study by replaying prior ask/tell calls and then generates the next suggestion. One trial is pending at a time; identical feedback is idempotent. Changing search configuration, worker identity, environment versions, objective, or comparison conditions cannot silently reuse incompatible history.

Repeated parameter tuples are recorded and skipped without another evaluation. Set the proposer's `maxSamplingAttempts` to cap total sampling attempts, including duplicates. Set the Optuna Policy's `maxTrials` or the grid Policy's `maxCandidates` to cap new evaluations. Omit any of these fields to leave that count unrestricted. Search can finish by exhausting a finite space or reaching a configured limit. Python sampling and repeated attempts count toward any experiment wall-time budget.

The result includes best feasible `candidateRef`, `measurementRef`, `parameters`, every `measurementRef`, and `searchStateRef`. Stop reasons are `max-trials`, `search-exhausted`, and `sampling-limit`; sampling-limit is not proof of exhaustive coverage. If no feasible result exists, status is `no-feasible-configuration` with null best-candidate fields. Selection uses measured results and does not establish a statistically verified performance improvement; remeasure selected configurations before claiming one.
