# Configure an experiment

English | [简体中文](configuration_zh.md) · [Getting started](../getting-started.md)

This guide explains experiment configuration, including Recipe fields, Agent backends and environment variables, metric selection, and how limits and budgets apply at each layer.

## Recipe fields and binding overrides

The following table lists the top-level Recipe fields. For a complete Recipe example, see [Getting started](../getting-started.md#2-write-the-recipe-and-choose-a-built-in-policy).

| Field           | Required | Responsibility                                                          | How to fill it                                                                                                                                                                                                                                            |
| --------------- | -------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | Yes      | Specify the Recipe format version.                                      | Specify the Recipe protocol version identifier, for example `rsi.recipe/v1` (currently the only supported version).                                                                                                                                       |
| `id`            | Yes      | Name this experiment configuration.                                     | For example, `my-terminal-skills`; use the CLI's `--id` to specify the experiment ID for a particular run.                                                                                                                                                |
| `description`   | No       | Explain the purpose of this configuration.                              | Write a short description.                                                                                                                                                                                                                                |
| `application`   | Yes      | Specify what to optimize and how it is managed.                         | Set `plugin` to an Application ID, such as `application.agentbundle`; fill `config` with the implementation's parameters, such as `target` and `baseline`. See [Application](built-in-components.md#application).                                         |
| `policy`        | Yes      | Choose the experiment flow and provide its parameters and initial data. | Set `id` to a Policy ID, such as `policy.wikiskill`; fill `config` with parameters required by the Policy, such as round counts and datasets, and `input` with its required input data, such as an initial candidate.                                     |
| `bindings`      | No       | Specify the plugins and configuration used by actions in the flow.      | Keys match the selected Policy's `require` names. The Policy uses these names to call plugins; the corresponding Recipe entry selects the implementation and parameters through `plugin` and `config`.                                                    |
| `budget`        | No       | Limit experiment calls, execution time, and other resources.            | For example, `evaluationRuns: 20` or `elapsedWallMs: 21600000`; see [Limits and budgets](#limits-and-budgets) for the fields.                                                                                                                             |
| `reflection`    | No       | Replace the Policy's default Reflection configuration.                  | Provide a configuration object whose `configFile` points to the Reflection configuration file, for example `{ configFile: ./reflection.yaml }`, following its separate [declaration and invocation rules](reflection.md#override-the-file-from-a-recipe). |

- A Recipe's `config` objects configure the selected Application, Policy, or plugin. Each component's configuration Schema defines the fields and their requirements.
  - You can use Schema defaults, and plugin bindings can also inherit the Policy's default configuration.
  - Supply any required parameters still missing after defaults are applied, and adjust other settings as needed.

- Use registered IDs in `application.plugin`, `policy.id`, and `bindings.<name>.plugin`.
  - For example, a Policy's evaluation step uses `use: evaluator`, and the Recipe's `bindings.evaluator` supplies the Evaluator plugin and configuration for that step.
- Recipe bindings override `defaults.bindings` from the Policy:
  - Fields with Policy-provided default inputs can be omitted. Omitting `plugin` inherits the default implementation.
  - When the Recipe and Policy use the same implementation, plain objects merge recursively; arrays, scalars, and null replace their previous values.
  - Supply entries in the Recipe's `bindings` for actions without default bindings in the Policy.

## Agent and environment variables

Agents in the optimization flow generate proposals, review deliverables, consolidate experience, and perform other model tasks. The built-in backends are Pi and Codex. Evaluator settings are separate from the optimization Agent: AgentBench configures the evaluated Agent's (Solver's) model services, InferenceBench configures inference service benchmarks, and OperatorBench configures kernel evaluation environments.

| Configuration target  | Purpose                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Evaluator             | Configure model services, tasks, or execution environments for the selected benchmark.                              |
| Pi (`agent.pi`)       | Call a specified model service through Pi to execute Agent tasks in the optimization flow.                          |
| Codex (`agent.codex`) | Execute Agent tasks in the optimization flow through a local Codex installation, using its login and configuration. |

### Environment variables

RSI does not automatically load `.env` files. Export variables in the process that launches the CLI.

- **Model environment variables depend on the selected components and their configuration; the framework has no single set of required model environment variables.**

### Evaluator

`evaluator.agentbench` uses `services` to configure the model services used by the evaluated Agent in benchmark tasks, separately from the optimization flow's `agent` binding. This example uses TerminalBench 4.0:

```yaml
# Recipe excerpt
bindings:
  evaluator:
    plugin: evaluator.agentbench
    config:
      services:
        default:
          model: ${EVALUATOR_MODEL_NAME}
          base_url: ${MODEL_ENDPOINT}
          api_key: ${MODEL_API_KEY}
      benchmark:
        name: terminalbench
        version: '4.0'
```

The `model`, `base_url`, and `api_key` fields in `services.default` specify the model name, service endpoint, and credential environment-variable reference.

When `evaluator.inferencebench` benchmarks an inference service, `application.inference` supplies the service endpoint and model name. See the [inference service example](../../../examples/artifacts/inference/parameter-grid/README.md#configuration) for configuration.

For kernel evaluation with `evaluator.operatorbench`, `task.directory` selects the task directory, `protocol` sets warmup and repeat counts and correctness tolerances, and `sdk` specifies Python, the NPU device, timeouts, and profiling options. This plugin requires a working Triton-Ascend / NPU environment; configure the optimization Agent separately through the `agent` binding. See the [operator optimization example](../../../examples/artifacts/kernel/transpose-copy/README.md) for setup and complete configuration.

### Pi backend

`agent.pi` executes Agent tasks in the optimization flow through Pi, with an explicitly configured model endpoint, model name, and credentials.

This fragment adds explicit request and invocation deadlines to a Policy that declares an `agent` binding:

```yaml
bindings:
  agent:
    plugin: agent.pi
    config:
      model: ${MODEL_NAME}
      base_url: ${MODEL_ENDPOINT}
      api_key: ${MODEL_API_KEY}
      thinkingLevel: low
      timeoutMs: 1800000
      executionTimeoutMs: 3600000
```

The [Pi Schema](../../../src/plugins/agent-pi/schema.ts) defaults to `thinkingLevel: low`, `contextWindow: 262144`, and `retries: 0`. Set `maxTokens` for a per-request output limit; it must fit `contextWindow` and the endpoint's capabilities.

- `api_key` must be an environment-variable reference, not a literal key.

- `timeoutMs` limits each model request. The underlying HTTP client uses a ten-minute request timeout when `timeoutMs` is omitted. Both timeout fields accept integer milliseconds from 1 to 2,147,483,647.
- `executionTimeoutMs` limits the complete Agent invocation, including model requests, tools, output correction, context compaction, retry waits, and awaited subagents. It does not reset between requests.

### Codex backend

`agent.codex` executes optimization tasks through a locally installed Codex CLI, using its login and configuration. Switch the Agent binding to this backend:

```yaml
bindings:
  agent:
    plugin: agent.codex
    config: {}
```

Setup and invocation responsibilities are split as follows:

- **The developer prepares the environment**: Install or update the Codex CLI and select `agent.codex` in the Recipe. Run `codex login` as the same operating-system user that launches RSI, then check with `codex login status`; configure model services and native tool permissions in that user's Codex configuration.
- **RSI handles invocation automatically**: RSI starts `codex app-server`, creates a temporary working directory and session for the task, supplies the prompt and file-reading tool, validates the result, and cleans up the process and temporary directory when the call ends.

The default Codex user configuration file is `~/.codex/config.toml`; see the [OpenAI Docs configuration guide](https://learn.chatgpt.com/docs/config-file/config-basic). RSI runs Codex in a system temporary directory by default; supply experiment-specific instructions through the relevant plugin's `prompt`, `guidance`, or other resources.

- The checkout's `AGENTS.md` and `.codex/config.toml` do not automatically become project settings for that invocation.

The [Codex Schema](../../../src/plugins/agent-codex/schema.ts) accepts `executable` (default `codex`), optional `model`, optional `thinkingLevel`, and optional `timeoutMs`. Omitted `model` and `thinkingLevel` retain local defaults. Explicit values override the model and reasoning effort for the call without rewriting local configuration.

- `timeoutMs` limits the complete call and accepts integer milliseconds from 1 to 2,147,483,647. Experiment cancellation and configured wall budgets also propagate to the process.

- This backend currently cannot enforce `maxModelCalls` or the experiment's `modelCalls` budget.

## Metric selection

`selector.metric` compares an incumbent and a new candidate using a specified metric. If the Policy uses a binding named `selector`, configure it in the Recipe as follows:

```yaml
bindings:
  selector:
    plugin: selector.metric
    config:
      metric: latencyMeanMs
      direction: minimize
      eligibility:
        - metric: candidateValid
          min: 1
      minRelativeImprovement: 0.02
```

This example checks correctness before comparing latency and replaces the incumbent only when latency drops by **more than 2%**. An ineligible candidate is rejected without requiring its latency value; the selection result's `candidateValue` is `null`.

| Setting                  | What to supply and what it does                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metric`, `direction`    | Choose the comparison metric and direction: `maximize` favors larger values, `minimize` smaller ones. Defaults to `successRate` and `maximize`.                                                                           |
| `eligibility`            | Conditions checked before the objective metric, such as correctness. Each entry supplies `metric` and at least one of `min` or `max`, with inclusive bounds. The incumbent must satisfy these conditions.                 |
| `constraints`            | Additional metric limits the candidate must satisfy, using the same fields as `eligibility`.                                                                                                                              |
| `minRelativeImprovement` | Minimum improvement fraction, at least 0 and less than 1; defaults to 0. A positive threshold requires a positive incumbent objective value, and the candidate's relative improvement must strictly exceed the threshold. |
| `itemId`, `statistic`    | Optionally select a task item and a distribution statistic. Distribution metrics require `mean`, `p50`, `p95`, or `p99`.                                                                                                  |
| `tieBreak`               | Currently supports only `retain-incumbent`: retain the incumbent when values are equal.                                                                                                                                   |

See the [Selector Schema](../../../src/plugins/selector-metrics/schema.ts) for all settings and the [kernel example Recipe](../../../examples/artifacts/kernel/transpose-copy/recipe.search.yaml) for a complete configuration.

## Limits and budgets

Omitted Runtime budget dimensions have no Runtime limit. Plugin, model-service, benchmark, and explicitly inherited Policy limits can still apply.

| Location                                              | Setting                                                                                    | Scope                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recipe                                                | `budget.operations`, `budget.evaluationRuns`                                               | Runtime calls, including nested calls; evaluator invocations can each cover several tasks.                                                                              |
| Recipe                                                | `budget.modelCalls`                                                                        | Requests charged by backends that support accounting, including Pi output corrections and subagents; does not limit benchmark Solver requests or native Codex requests. |
| Recipe                                                | `budget.elapsedWallMs`, `budget.cleanupReserveMs`                                          | Experiment execution time and a separate cleanup deadline, in milliseconds; resume retains elapsed time since the original start.                                       |
| Pi                                                    | `maxTokens`, `contextWindow`                                                               | Model output and context size per request.                                                                                                                              |
| Pi                                                    | `timeoutMs`, `executionTimeoutMs`                                                          | Per-request and complete-invocation time, in milliseconds.                                                                                                              |
| Codex                                                 | `timeoutMs`                                                                                | Complete-invocation time, in milliseconds.                                                                                                                              |
| Operator Proposer                                     | `modelRequestTimeoutMs`                                                                    | Shared duration limit in milliseconds for a complete generation, diagnosis, or summary stage, including tool continuations and delegated Agents.                        |
| `proposer.agent`, `memory.agent`, `selector.artifact` | `maxModelCalls`                                                                            | Per-Agent-invocation request limit when supported by the backend; a direct Agent call sets `steps[].with.maxModelCalls`.                                                |
| AgentBench Evaluator                                  | `services.<service>.maxTokens`                                                             | Per-turn output limit for that evaluation model service; avoid also setting a duplicate Solver output limit.                                                            |
| AgentBench / InferenceBench Evaluator                 | `run.timeoutSeconds`                                                                       | Benchmark task timeout; when omitted, SDK profile or fallback limits apply.                                                                                             |
| OperatorBench Evaluator                               | `sdk.timeoutSeconds`, `sdk.profiling.attemptTimeoutSeconds`                                | SDK call and individual profiling-attempt limits in seconds; both evaluation and profiling calls count toward `budget.evaluationRuns`.                                  |
| Inference Application                                 | `remote.timeoutMs`, `healthcheck.timeoutMs`                                                | Remote commands and readiness; remote readiness inherits an explicit remote timeout unless overridden.                                                                  |
| Optuna Proposer                                       | `python.timeoutMs`, `maxSamplingAttempts`                                                  | Per-worker duration and total sampling attempts, including duplicates; `policy.config.maxTrials` separately limits evaluations.                                         |
| Reflection file                                       | `budget.modelCalls`, `budget.timeoutSeconds`                                               | Per-Reflection-invocation limits; `modelCalls: 0` prevents the built-in model generator from starting, and positive call limits require backend accounting.             |
| Target                                                | `entries[].content.maxBytes`, `constraints.maxChangedFiles`, `constraints.maxChangedBytes` | File size and total commit size; these limits must be set explicitly.                                                                                                   |
| Policy                                                | `steps[].with.editConstraints`                                                             | Per-call limits on changed files, bytes, and subtrees where supported by the contract.                                                                                  |
