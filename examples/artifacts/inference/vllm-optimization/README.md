# vLLM Ascend framework tuning

The `vllm-optimization` Recipe uses `parameter.agent` to establish a baseline and tune framework parameters with AISBench. Codex reads the candidate and authorized evidence from its workspace. The Recipe supplies a tuning prompt, a shared skill and three roles. `selector.inference` accepts progress toward the latency targets before maximizing request throughput within those targets.

## Parameter selection

The launcher reads the installed vLLM `serve` parser during Application initialization and exposes only options in the example's explicit allowlist. The Proposer receives that catalog and previous candidate settings alongside AISBench measurements. It can propose adjacent values, combine compatible levers, or remove an inherited option. The supported families are scheduling and batching, prefix caching, cache capacity, and graph execution. The available keys also depend on the installed release. Each proposed edit uses `op: replace` and supplies the complete contents of `tuning.json`.

The launcher checks each proposal against the same allowlist and installed catalog before launch. Model and cache precision, quantization, speculative decoding, and arbitrary structured configs are excluded; this example does not evaluate output quality. The served model, tokenizer, endpoint, selected devices, TP/DP/PP topology, and model length remain fixed deployment settings. `remote.memoryUtilization` supplies the initial memory fraction. A supported `gpu_memory_utilization` in `tuning.json` overrides it for that candidate when calibration is disabled.

The example measures 160 streaming requests with 2048 input tokens, 512 output tokens, concurrency 16, and request rate 0. Its latency targets are `ttftP90 <= 1000 ms` and `tpotP90 <= 100 ms`. While targets are missed, a candidate may replace the incumbent when no constraint violation worsens and at least one decreases. Equal violations require higher `requestThroughput`. A satisfied target must remain satisfied; after both are met, throughput must improve while preserving them. The result retains the best candidate even when the targets remain unmet.

## Prepare the host

Run RSI, the single-node vLLM Ascend server, and the AISBench load generator on the same Ascend Linux host. The launcher binds to `127.0.0.1`. The SDK reaches the load generator over SSH to that host. Install compatible vLLM, `vllm-ascend`, `torch-npu`, and CANN for the target NPU, and prepare AISBench with the Python environment used by its SSH runner. Make the `codex` CLI and its configured model provider available to RSI. [vLLM Ascend installation guide](https://docs.vllm.ai/projects/ascend/en/latest/getting_started/installation.html)

Edit `bindings.evaluator.config.benchmark.solver.config` in [recipe.yaml](recipe.yaml) with the actual SSH user, AISBench work directory, Python executable, installed AISBench version, writable job root, and tokenizer directory. Use a tokenizer compatible with the served model. The Recipe's `ttftP90` and `tpotP90` thresholds are examples in milliseconds. Set them to the serving workload's SLO before starting the experiment, and keep [the tuning prompt](prompts/tuning.md) synchronized with any workload or target changes. The same workload and thresholds apply to the baseline and every candidate.

Choose an unused port, matching the Recipe endpoint, and set the host's deployment variables. Keep the model and these variables fixed when resuming an experiment.

```sh
export VLLM_ASCEND_MODEL_PATH=/models/inference-model
export VLLM_ASCEND_PYTHON=/opt/vllm-ascend/bin/python
export ASCEND_RT_VISIBLE_DEVICES=0
export VLLM_ASCEND_TENSOR_PARALLEL_SIZE=1
export VLLM_ASCEND_MAX_MODEL_LEN=4096
export VLLM_ASCEND_STATE_DIR="$PWD/.rsi/vllm-ascend"
export VLLM_API_KEY="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
```

Keep a nonempty `VLLM_API_KEY` available for the Evaluator. The serving process uses the same environment reference for API authentication. [vLLM serving authentication](https://docs.vllm.ai/en/latest/getting_started/quickstart/#online-serving)

The launcher queries the visible devices and installed package versions before starting vLLM, fingerprints the local model files, and records process ownership under `VLLM_ASCEND_STATE_DIR`. Keep the state directory stable for a given port. The launcher gives the service 540 seconds to become ready. To change this limit, set `VLLM_ASCEND_STARTUP_TIMEOUT_SECONDS` and keep it below `application.config.healthcheck.timeoutMs` after converting to milliseconds. RSI reports startup failures, and full launch logs stay in the local state directory.

## Run from the repository root

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm ember-rsi validate examples/artifacts/inference/vllm-optimization/recipe.yaml
pnpm ember-rsi run examples/artifacts/inference/vllm-optimization/recipe.yaml --id vllm-ascend-tuning
```

Supply a baseline configuration that can start the service. RSI runs AISBench once on that configuration before proposing any changes. The search starts after a complete, comparable baseline measurement. In each tuning round the Proposer returns up to `candidatesPerRound` ranked alternatives from the same incumbent. The Policy invokes `evaluator.inferencebench` directly for each candidate, serially. The next batch uses the selected incumbent and completed trial history. Startup or evaluation failures terminate the experiment after cleanup. `maxTrials` caps candidate attempts across batches. The Runtime enforces the Recipe's experiment budget. If the budget is exhausted, use `ember-rsi show <experiment-id>` to see the stop reason and any checkpointed result under `partialOutput`.

The local launcher unit tests run without an NPU.

```sh
python3 -B -m unittest discover -s examples/artifacts/inference/vllm-optimization/tests
```
