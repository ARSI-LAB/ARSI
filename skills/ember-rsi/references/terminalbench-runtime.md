# TerminalBench asset and solver runtime contract

This describes the supplied Evaluator SDK's TerminalBench 4.0 + AgentBundle DSH + local Docker path, not remote Ray or every benchmark. The consumer must be able to import both `ember-rsi` and `ember-evaluator` public package roots. Never import their internal files. The SDK is an explicit prerequisite for the standalone preflight helper.

## Prepare tasks through public APIs

Copy the base starter and TerminalBench overlay as described in [SDK evaluators](sdk-evaluators.md) and run `node terminalbench-preflight.mjs terminal-bench/html-js-filter` from the copy. It uses public `HarborBenchmark` and `parseHarborConfig`, with `resolveSource(null, signal)`, `enumerate(source, signal)` and `prepare(ref, source, signal)`. These download and validate task metadata but do not start a solver or invoke a model. The script separately performs Docker and authenticated `/models` connection probes.

The helper pins the TerminalBench 4.0 archive URL, SHA256 and task layout in one configuration. Update those together when adopting another benchmark release.

The SDK downloads into `cacheDir`, verifies the archive digest, safely extracts it and records source/file identities. Do not download an arbitrary latest archive or replace task tests. `prepare` exposes `solveEnv.image`, `verifyEnv.image` and optional `solveEnv.services[*].image`: those are the authoritative task image references. Do not select cached `solve-base-*` images merely by tag resemblance. SDK preparation obtains the pinned images and derives runtime/solver layers automatically during evaluation. Public preflight establishes task identity and asset metadata, not successful image building or solving. Image fetch/build failures from the first bounded evaluation are preparation failures to diagnose, not proof the task was scored.

Use the emitted **absolute** `cacheDir` as `evaluator.config.benchmark.config.cacheDir`, alongside `benchmark.name: terminalbench` and `version: '4.0'`, so actual evaluation uses the same verified cache. `TERMINALBENCH_CACHE` may select a task-owned shared cache. Downloads and preparation need time separate from solving; do not charge a cold image download as a valid zero score. Keep verification content private: report only task identities, source revision and image metadata, not `PreparedTask.verification` or hidden tests to proposal models.

## Select the actual Docker daemon

Run `docker context ls` and test the appropriate context with `docker --context <name> info`. If the default socket is absent, use `DOCKER_CONTEXT=<name>` in the **launching process environment** for both preflight and the RSI host. A `--context` flag on one manual probe does not configure the SDK's later Docker subprocesses. Do not change the global context or touch unrelated containers. The helper compares each prepared solve/verify environment’s declared CPU/memory against Docker `NCPU`/`MemTotal`, then starts a disposable amd64 Node container with the actual workspace and cache bind mounts. Both checks must pass in the same context. For example, html-js-filter declares 2 CPUs and 8192m memory; a 4 GiB Docker VM cannot run it. Do not lower benchmark requirements to pass. A reachable large VM can still lack the required shared directory: use an explicitly supplied, task-owned workspace under an existing VM-visible writable mount, and keep run logs, cache and bundle paths visible there. Never assume all host paths are shared or that switching contexts preserves their mounts. Do not change shared VM configuration as a routine retry.

## Where the solver and model connection run

The coordinator and RSI editing Agent run on the host. For Docker AgentBundle tasks, DSH runs inside the solve container. The Evaluator prepares its runtime, uploads/installs the selected bundle and injects model settings; do not hand-install DSH into the baseline or override the RSI-owned `benchmark.solver.config.path`.

The SDK obtains solver credentials/model settings from `evaluator.config.services.default` (unless an explicit supported service binding selects another service). Isolated `model-api` execution uses a separate SDK gateway container and a Unix-socket volume; the solve container reaches it through a loopback forwarder at port 18080. The SDK rewrites the solver settings to that mapped endpoint. Do **not** put the private 18080 endpoint in the Recipe yourself.

The gateway rewrites configured host loopback addresses to `host.docker.internal` and creates that alias with `host-gateway`. With a VM-based Docker daemon, this can refer to the VM instead of the workstation. In a Lima/Colima environment, `host.lima.internal` can be a workstation route; use it only after a successful probe. Set `SOLVER_MODEL_ENDPOINT` to the candidate reachable API base, then run the helper again. Use the successful `solverEndpoint` for evaluator `services.default.base_url`; keep the host `MODEL_ENDPOINT` for `agent.pi`. Use the authorized provider endpoints and preserve any configured spending controls.

The helper runs authenticated GET `/models` using Node in the SDK's pinned gateway image, with the same host-gateway alias. It sends credentials through stdin and removes its named container in `finally`; it does not depend on curl in the task image or consume inference requests. This confirms gateway-to-provider connectivity. Actual SDK socket/forwarder readiness, bundle installation and solver model use are checked during the bounded evaluation and its receipts. Do not demand a nonexistent all-in-one readiness API before allowing that execution.

## Run and inspect

After source metadata, Docker access, gateway connectivity and the external request/token allowance are confirmed, launch the small Recipe. The supplied example starts with one task, one proposal round and concurrency one; adapt those limits to the authorized campaign. A real run may still reveal a preparation error: preserve native error details and follow bounded recovery, without altering the scorer or manufacturing metrics.

Verify actual Measurement `status`, `coverage`, metric definitions and native task results. Confirm the selected Candidate belongs to the returned Measurement and compare under identical task IDs and conditions. No-change or a tie is legitimate but does not prove a changed candidate was evaluated; report that boundary explicitly.

Each native evaluator run has its own run ID, distinct from the RSI experiment ID. Native containers and gateway volumes are labelled `ascendagent.run`, `ascendagent.task`, `ascendagent.attempt`, `ascendagent.phase`. Use the native run IDs in owned results to inspect `docker ps -a --filter label=ascendagent.run=<id>` and `docker volume ls --filter label=ascendagent.run=<id>`. Also check RSI instances and native cleanup diagnostics. Preserve shared cached images and unrelated workloads; absence of running processes alone is not cleanup evidence.
