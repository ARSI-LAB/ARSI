# vLLM Ascend framework tuning

The `vllm-optimization` Recipe uses `parameter.agent` to establish a baseline and tune framework parameters with AISBench. Codex reads the candidate and authorized evidence from its workspace. The Recipe supplies a tuning prompt, a shared skill and three roles. `selector.inference` accepts progress toward the latency targets before maximizing request throughput within those targets.

## Parameter selection

The launcher reads the installed vLLM `serve` parser during Application initialization and exposes only options in the example's explicit allowlist. The Proposer receives that catalog and previous candidate settings alongside AISBench measurements. It can propose adjacent values, combine compatible levers, or remove an inherited option. The supported families are scheduling and batching, prefix caching, cache capacity, and graph execution. The available keys also depend on the installed release. Each proposed edit uses `op: replace` and supplies the complete contents of `tuning.json`.

The launcher checks each proposal against the same allowlist and installed catalog before launch. Model and cache precision, quantization, speculative decoding, and arbitrary structured configs are excluded; this example does not evaluate output quality. The served model, tokenizer, endpoint, selected devices, TP/DP/PP topology, and model length remain fixed deployment settings. `remote.memoryUtilization` supplies the initial memory fraction. A supported `gpu_memory_utilization` in `tuning.json` overrides it for that candidate when calibration is disabled.

The example measures 160 streaming requests with 2048 input tokens, 512 output tokens, concurrency 16, and request rate 0. Its latency targets are `ttftP90 <= 1000 ms` and `tpotP90 <= 100 ms`. While targets are missed, a candidate may replace the incumbent when no constraint violation worsens and at least one decreases. Equal violations require higher `requestThroughput`. A satisfied target must remain satisfied; after both are met, throughput must improve while preserving them. The result retains the best candidate even when the targets remain unmet.

## Prepare the host

Use [recipe.yaml](recipe.yaml) when RSI, the single-node vLLM Ascend server, and the AISBench load generator run on the same Ascend Linux host. To keep RSI on a local macOS/Linux machine, use the [SSH variant](#run-rsi-locally-over-ssh). The launcher binds to `127.0.0.1`. The SDK reaches the load generator over SSH to that host. Install compatible vLLM, `vllm-ascend`, `torch-npu`, and CANN for the target NPU, and prepare AISBench with the Python environment used by its SSH runner. Make the `codex` CLI and its configured model provider available to RSI. [vLLM Ascend installation guide](https://docs.vllm.ai/projects/ascend/en/latest/getting_started/installation.html)

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

## Run RSI locally over SSH

[recipe-ssh.yaml](recipe-ssh.yaml) keeps the same optimization flow, workload, and selection rules. It selects [vllm-ssh.py](scripts/vllm-ssh.py) as the existing Application's `remote.script`. The wrapper forwards JSON lifecycle requests to the original launcher on the remote host and owns a dedicated SSH tunnel for local health checks. No Application, Runtime, or Policy extension is required.

The local machine needs the repository, Node/pnpm, Python 3, OpenSSH, and the configured Codex CLI. The remote Linux host needs the model, compatible vLLM environment, AISBench, and one copy of [vllm-ascend.py](scripts/vllm-ascend.py) from the same checkout revision. RSI and its Node dependencies stay local. Prepare an independent remote directory for this experiment and copy the launcher there; do not overwrite another experiment's launcher or state. Pin its SHA-256 locally; the wrapper verifies the remote file before executing it.

Use SSH key authentication and verify the host key in advance. The wrapper requires batch mode and strict host-key checking. It also uses OpenSSH local forwarding and control sockets, so the SSH server must permit forwarding. The wrapper accepts a DNS hostname or IP address and explicit port/identity settings. It ignores SSH configuration files to avoid inheriting unrelated tunnels; SSH aliases and `ProxyJump` are not supported by this example. Standard `known_hosts` files, default identity files, and the SSH agent remain available. Both the wrapper and AISBench must reach the same host and network namespace as vLLM.

Set these variables on the **local** machine before validation or execution. Paths marked remote refer to files on the server. Values below are placeholders; use dedicated, unused devices and directories. The wrapper sends only its explicit deployment-variable allowlist over encrypted stdin; it does not forward the entire local environment or store the API key in its ownership records.

```sh
export VLLM_SSH_HOST=inference.example.org
export VLLM_SSH_USER=benchmark
export VLLM_SSH_PORT=22
# Optional: export VLLM_SSH_IDENTITY_FILE="$HOME/.ssh/inference_key"
export VLLM_SSH_REMOTE_PYTHON=/opt/vllm-ascend/bin/python
export VLLM_SSH_REMOTE_LAUNCHER=/opt/ember-rsi-example/vllm-ascend.py
export VLLM_SSH_REMOTE_LAUNCHER_SHA256="$(python3 -c 'import hashlib; from pathlib import Path; print(hashlib.sha256(Path("examples/artifacts/inference/vllm-optimization/scripts/vllm-ascend.py").read_bytes()).hexdigest())')"
export VLLM_SSH_STATE_DIR="$PWD/.rsi/vllm-ssh"
export VLLM_ASCEND_MODEL_PATH=/models/inference-model
export VLLM_ASCEND_STATE_DIR=/var/tmp/ember-rsi-vllm
export ASCEND_RT_VISIBLE_DEVICES=0
export VLLM_ASCEND_TENSOR_PARALLEL_SIZE=1
export VLLM_ASCEND_MAX_MODEL_LEN=4096
export VLLM_API_KEY="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
```

`VLLM_SSH_REMOTE_PYTHON` also supplies the remote launcher's `VLLM_ASCEND_PYTHON`. The model path, visible devices, remote state directory, API key, and optional tensor-parallel size, model length, and startup timeout are forwarded explicitly. Required accelerator libraries must already be available to that remote Python environment; shell activation scripts are not automatically sourced. Keep both state directories and all deployment settings stable until cleanup has completed, including after interruption. Use a short absolute local state path if the SSH control socket exceeds the platform's path-length limit.

Edit `bindings.evaluator.config.benchmark.solver.config.remote` in `recipe-ssh.yaml` with the matching SSH host/user/port and, if needed, identity file, plus the actual remote AISBench Python, work path, installed version, and job root. Set `tokenizerPath` to the remote model's tokenizer. Wrapper environment variables do not substitute these Recipe fields automatically.

The example uses `http://127.0.0.1:18080` on **both** machines. Choose a port free on both hosts. Local health checks go through the tunnel; AISBench accesses the remote loopback port directly, so benchmark traffic does not cross the local tunnel. The wrapper refuses to take over an occupied local port. Before running, inspect existing experiments, including any Hyperloom runs, and use only free devices/ports and independent working directories. Do not stop unrelated services or modify their environments.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm ember-rsi validate examples/artifacts/inference/vllm-optimization/recipe-ssh.yaml
pnpm ember-rsi run examples/artifacts/inference/vllm-optimization/recipe-ssh.yaml --id vllm-ssh-tuning
```

For an initial baseline-plus-one-candidate smoke run, set `maxTrials: 1`, `candidatesPerRound: 1`, and `budget.evaluationRuns: 2` in a local Recipe copy beside the example. A successful run measures the baseline, applies and measures one proposed candidate, records selection, and releases the service and tunnel. An unchanged proposal only validates the baseline path. If you reduce the workload or change targets, update the tuning prompt to match. Synthetic mock measurements validate orchestration, not performance improvement or output quality.

On stop, the wrapper first requires the remote launcher to confirm that its service stopped, then closes its own tunnel and removes local ownership. If SSH fails or the result is unknown, ownership remains for recovery. Restore connectivity and the original configuration, and inspect cleanup records before reusing resources. Retain the same Recipe, experiment ID, local RSI data, and state directories for recovery. If Runtime reports unresolved cleanup, `--resume` is blocked: first reconcile the retained instance through the existing Application `release` lifecycle, then confirm external cleanup with `Manager.reconcileCleanup` before resuming. That confirmation method does not stop services itself; the CLI has no automatic retry for failed cleanup. Do not delete ownership files to force a retry. Remote launch diagnostics remain in `VLLM_ASCEND_STATE_DIR`; SSH transport errors are deliberately concise to avoid exposing deployment credentials.

## Mock verification

The SSH tests run the real wrapper and RSI modules with local substitutes for SSH, vLLM, model output, and the external evaluation runner. They require Python 3 and local loopback sockets but no NPU, remote host, model credentials, or real AISBench installation.

```sh
node --import tsx --test tests/unit/inference-ssh.test.ts
```
