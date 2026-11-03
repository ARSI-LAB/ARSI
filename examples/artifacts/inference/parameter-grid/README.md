# Remote vLLM parameter grid

This example searches the same two parameters as the earlier Runner example:
`max_num_seqs` (32, 64) and `max_num_batched_tokens` (1024, 2048).
The policy contains no parameter names. The grid proposer lazily enumerates
`searchSpace` in declaration order, with the last dimension changing fastest.
Its explicit cursor is checkpointed by the policy; no process-local search
history is required. The baseline is the first measured point, including when
proposing it produces no file change.

Each axis declares a nonempty, duplicate-free `values` list. Values can be numbers,
strings, booleans, null, arrays or objects, including mixed types in one axis.
Arrays and objects are atomic choices; object key order does not distinguish
choices. Null writes a JSON null; it does not remove or omit a parameter. Numeric
values must be finite, and all values must be valid JSON. Lists retain declaration
order. Interval fields (`min`, `max`, `step`) are no longer accepted.
Any number of axes can be combined; the complete Cartesian product is limited
to 1,000,000 points.
For example, this single experiment proposes 16 combinations:

```yaml
searchSpace:
  - name: max_num_seqs
    values: [32, 4, 16, 1]
  - name: max_num_batched_tokens
    values: [2048, 4096, 8192, 16384]
```

Set the policy's `maxCandidates` and evaluation budgets to cover all 16 points;
the proposer does not override policy limits. Include the baseline in the grid
or measure it separately. Resume with the same ordered configuration and cursor.

For adaptive sampling, see the [TPE recipe](../parameter-tpe/README.md).

## Configuration

Both recipes use the baseline, target and lifecycle script in `../shared/`.
Keep this recipe directory and `shared/` together when copying the example.

- [recipe.yaml](recipe.yaml): application lifecycle, ordered search space,
  benchmark protocol and budgets.
- [shared/scripts/remote-vllm.py](../shared/scripts/remote-vllm.py): minimal lifecycle template with
  the request/response contract and `start`, `status`, `stop` functions to implement.
  The supplied template raises `NotImplementedError`; it cannot deploy a server yet.
- [shared/target.yaml](../shared/target.yaml): only the candidate's `tuning.json` may change.

Implement the template using SSH or your deployment system. Keep host, model,
device and authentication settings in the script or local environment. For SSH,
use the local SSH configuration or agent. Application reads the candidate's
`parametersFile` and sends its JSON values as `request["parameters"]`; it does
not upload `tuning.json`. Use the supplied `memoryUtilization` for
`--gpu-memory-utilization`, and persist remote ownership so separate commands can
identify and clean up the same instance. Return queried device/model/software
identities, not placeholder values; the script documents each response.

The deployment adapter must validate supported engine parameters and map each
value to the engine's argument format: booleans may require enable/disable flags,
and structured values may require JSON serialization. Do not stringify every
value indiscriminately or interpolate values into shell commands. Deployment and
calibration-owned parameters remain forbidden in the candidate, including
`gpu_memory_utilization`, `tensor_parallel_size`, `max_model_len`, `dtype` and
`enable_prefix_caching`; accepting JSON types does not make these tunable.

For example, a deployment adapter that supports these options can search a
string axis and a boolean axis alongside the numeric axes:

```yaml
- name: kv_cache_dtype
  values: [auto, fp8]
- name: enforce_eager
  values: [false, true]
```

Adding those axes to the four-point recipe yields 16 combinations. Update
`maxCandidates` and evaluation budgets accordingly. Existing range-based recipes
must be migrated for new runs; resume requires the original locked configuration.

Use a dedicated Linux tuning host. Replace `192.0.2.10` in the recipe with the
service address reachable from the Evaluator client. Serve the model name from
`request["endpoint"]["model"]`. Keep the client tokenizer aligned with the deployed
model. Set `AGENTX_TOKENIZER` to the matching tokenizer repository or local directory.
The local AgentX client needs Python 3.11–3.13 with venv support; the Evaluator SDK
installs its isolated runtime on first use. The control machine also needs your
deployment tools. The remote host needs vLLM and device identity query tools.
The service must support streaming Chat Completions, `ignore_eos`, trace-defined
output lengths, and at least 256K context with sufficient headroom. Short-context
models cannot run this workload; traces are not truncated to fit them.
No example credentials are included. For an unauthenticated test deployment set
`VLLM_API_KEY=EMPTY`; otherwise use the deployed service's key.

All runtime artifacts belong under `.rsi/`, including SDK outputs and lifecycle
facts. Keep local script overrides there too and update `remote.script` in the recipe.
The candidate contains only tunable engine parameters; scripts, credentials and
deployment settings are outside its editable scope.

## Evaluation

The Application invokes your script to start and explicitly stop each owned remote instance.
It calibrates memory utilization from 0.90 down to 0.80 at the grid's upper
corner before the first measurement, then persists and reuses that choice for
the experiment. Device, software and model identity must remain consistent.
Changing the search space requires updating the calibration corner as well.

`evaluator.inferencebench` calls the adjacent Evaluator SDK's `agentx` benchmark
with `agentx-replay`, using the remote endpoint supplied by the Application.
The example replays eight traces from the 256K corpus with four concurrent session
trees and a 7200-second replay bound. Input/output lengths, prefix reuse, turns,
sub-agent dependencies and waits come from the traces. It does not execute the
original tools. The outer local scheduler runs one measurement point at a time;
session-tree concurrency is a separate workload setting.

Replay must finish the selected traces to yield a comparable point. Reaching the
replay bound before completion does not produce a valid optimization score.
The 14400-second task timeout also covers preparation, warmup and drain. The
24-hour experiment budget covers up to four candidate evaluations and cleanup;
initial runtime/data/tokenizer downloads add overhead. This is a bounded replay,
not the standard AgentX submission protocol.

Only candidates satisfying the latency SLO can become the incumbent. Selection
maximizes mean `outputThroughput` at `agentx-256k-replay-c4`, subject to
`requestLatency.p99 <= 1500 ms`, retaining ties. The recipe explicitly overrides
the policy's generic selector binding with these AgentX metrics. The trace
workload, calibrated memory, software and hardware identity are fixed comparison
conditions. Technical failures stop the run instead of becoming a zero score.
An empty feasible set is reported explicitly. `maxCandidates` is separate from
space exhaustion. One SDK evaluation contains the selected trace replay;
`evaluationRuns` counts SDK evaluations, not individual HTTP requests.

This example searches engine parameters using an AgentX workload. It does not
implement the vLLM bench request-rate search, a final profiling pass or held-out
confirmation. It uses actual deployed model weights. No production performance
or quality improvement is established by this example.

## Run

The project uses the adjacent `AscendAgent-Evaluator` through its existing local
file dependency. Build that repository and refresh the frozen dependency install
after changing its SDK, then build RSI. No dependency version change is needed.

```sh
ember-rsi validate examples/artifacts/inference/parameter-grid/recipe.yaml
ember-rsi run examples/artifacts/inference/parameter-grid/recipe.yaml --id parameter-grid-first
ember-rsi show parameter-grid-first
```

Validation does not check that the template is implemented, start a remote service,
or prove that deployment settings are usable. Resume only the same locked configuration and after reconciling any
unknown remote lifecycle outcome:

```sh
ember-rsi run examples/artifacts/inference/parameter-grid/recipe.yaml --id parameter-grid-first --resume
```

Cancellation attempts bounded owned cleanup. If deployment connectivity prevents it,
retain the lock and inspect the saved lifecycle request before retrying; do not
delete locks or kill a process solely by an unverified historical PID.
