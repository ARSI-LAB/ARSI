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

Both backends run in the workspace prepared for the Agent call. The `contract.agent` input supplies `cwd`, `goal`, and `outputSchema`, with `role` for Pi delegation through the Runtime. Codex delegates through its native tool. The backend reads instructions from `AGENTS.md` and uses the workspace files for task context.

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

When the optimizer needs the public task prompt, set `run.includeTaskAnswer: true` in the Evaluator configuration so the SDK records task data. RSI publishes the public prompt as `task-input` execution evidence for later plugins; reference answers remain in private native records.

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

- This backend currently cannot enforce the experiment's `modelCalls` budget.

## Inference optimization

For inference optimization, `evaluator.inferencebench` supports `benchmark.name: aisbench` with the bundled SSH solver, or `agentx` with the replay solver. Use the same benchmark workload for the baseline and candidate trials. The Runtime enforces the experiment-wide limits in the Recipe’s `budget`.

For `parameter.agent`, `policy.config.candidatesPerRound` defaults to 4 and accepts 1 through 6. The tuning Proposer returns that many candidates at most, ordered by priority and based on the same incumbent. The Policy invokes `evaluator.inferencebench` directly and serially, then uses the latest incumbent when requesting the next batch. `maxTrials` caps candidate attempts across all batches. Startup or evaluation failures stop the experiment and trigger instance cleanup.

The default `selector.inference` uses `metric` and `direction` for the primary objective, `constraints` for performance targets, and optional `eligibility` for hard requirements. It can accept reduced constraint violations before every target is met, while preventing regressions in satisfied constraints. See [Built-in components](built-in-components.md#loop-components) for the selection rules. The Policy retains the incumbent and reports `candidateFeasible` separately from whether a candidate was accepted.

With `application.inference.config.remote.discoverParameters: true`, the launcher reports its installed parameter catalog at initialization. Agent proposals receive the catalog in `context/input.json` as `target.parameterCatalog`. The vLLM Ascend example enables this feature and limits the catalog to an explicit performance-parameter allowlist; precision, quantization, speculative decoding, and structured configs are excluded.

RSI can also run on a local macOS/Linux machine while vLLM and AISBench run on a remote Linux host. The [SSH example Recipe](../../../examples/artifacts/inference/vllm-optimization/recipe-ssh.yaml) selects a local SSH wrapper through the existing `remote.script` field. The wrapper forwards lifecycle requests and maintains a dedicated loopback tunnel for local health checks. AISBench runs on the same remote host and accesses vLLM directly. Use the same free endpoint port on both machines, and keep the wrapper's SSH settings aligned with the Evaluator's SSH settings. See the [example setup and recovery instructions](../../../examples/artifacts/inference/vllm-optimization/README.md#run-rsi-locally-over-ssh). This is an example-level adapter; it adds no Application configuration fields or Runtime/Policy behavior.

## Proposer file edits

`proposer.agent` uses one Agent output schema for file edits. Each entry in `edits` has a path and an `op`. Use `replace` or `create` with full `content`, `patch` with exact `oldText` and `newText` in `changes`, or `delete` with only the path. A proposal can combine operations on different paths. The Proposer and Application enforce the edit constraints and Target permissions.

A `patch` must be the only operation for its path. Duplicate whole-file edits use the existing merge and conflict handling.

To migrate a custom Proposer prompt, remove `editProtocol` from the binding and give every edit an `op`. For whole-file edits, use `replace` for an existing file, `create` for a new file, and `delete` for a deletion. Existing tagged patch operations keep their fields.

## Limits and budgets

When an experiment budget is exhausted, the Runtime records `stopReason: budget-exhausted` and the limit in `budgetMetric`. Use `ember-rsi show <experiment-id>` to inspect the record. If the Policy output can be evaluated and validated from the last committed checkpoint, the record includes it as `partialOutput`. For `parameter.agent`, this retains the incumbent candidate and its measurement when available, even when `candidateFeasible` is false. Use the experiment record’s top-level `stopReason` to determine why the run ended.

Omitted Recipe binding settings first inherit Policy defaults. The “When omitted” column describes settings that remain unset; limits at other layers can still apply.

| Location                                              | Setting                                           | Meaning                                                                                                                                                               | When omitted                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Recipe                                                | `budget.operations`                               | Maximum Runtime operation calls, including nested calls.                                                                                                              | No experiment-wide call limit.                                                                                    |
| Recipe                                                | `budget.evaluationRuns`                           | Maximum evaluation calls; one call can cover several tasks. OperatorBench evaluation and profiling calls both count.                                                  | No experiment-wide evaluation-call limit.                                                                         |
| Recipe                                                | `budget.modelCalls`                               | Maximum model requests charged by supported backends, including retries, output corrections, and subagents; does not limit benchmark Solver or native Codex requests. | No experiment-wide model-call limit.                                                                              |
| Recipe                                                | `budget.elapsedWallMs`                            | Maximum elapsed experiment time in milliseconds; resume includes time spent interrupted and does not restart the clock.                                               | No experiment-wide elapsed-time limit.                                                                            |
| Recipe                                                | `budget.cleanupReserveMs`                         | Separate duration limit in milliseconds for cleanup, such as releasing instances and closing plugins.                                                                 | No Runtime cleanup deadline.                                                                                      |
| Pi                                                    | `maxTokens`                                       | Maximum output tokens per model request.                                                                                                                              | Omit the output-token limit from the request; the model service decides.                                          |
| Pi                                                    | `contextWindow`                                   | Context-window size in tokens used by Pi for context management; match it to the model's capabilities.                                                                | 262144 tokens.                                                                                                    |
| Pi                                                    | `timeoutMs`                                       | Duration limit per model request, in milliseconds.                                                                                                                    | The underlying HTTP client uses 600000 ms (10 minutes).                                                           |
| Pi                                                    | `executionTimeoutMs`                              | Duration limit for a complete Agent call in milliseconds, including requests, tools, compaction, retry waits, and subagents.                                          | No separate duration limit for the complete call.                                                                 |
| Codex                                                 | `timeoutMs`                                       | Duration limit for the complete Agent call, in milliseconds.                                                                                                          | RSI sets no separate timeout for the call.                                                                        |
| Operator Proposer                                     | `modelRequestTimeoutMs`                           | Shared duration limit for a complete model stage in milliseconds, including tool continuations and delegated Agents.                                                  | 120000 ms (2 minutes).                                                                                            |
| AgentBench Evaluator                                  | `services.<service>.maxTokens`                    | Per-turn output-token limit for the model service used by the evaluated Agent.                                                                                        | Determined by Solver or model-service defaults.                                                                   |
| AgentBench / InferenceBench Evaluator                 | `run.timeoutSeconds`                              | Duration limit for one benchmark task attempt, in seconds.                                                                                                            | Use the SDK benchmark profile's value; fall back to 7200 seconds (2 hours) if the profile omits it.               |
| OperatorBench Evaluator                               | `sdk.timeoutSeconds`                              | Duration limit for one kernel evaluation or profiling operation, in seconds.                                                                                          | Required; no default.                                                                                             |
| OperatorBench Evaluator                               | `sdk.profiling.attemptTimeoutSeconds`             | Duration limit for an individual profiling attempt, in seconds.                                                                                                       | SDK default: 300 seconds (5 minutes).                                                                             |
| Inference Application                                 | `remote.timeoutMs`                                | Duration limit for one remote-script invocation, in milliseconds.                                                                                                     | No separate duration limit for the remote call.                                                                   |
| Inference Application                                 | `healthcheck.timeoutMs`                           | Duration limit for waiting for the inference service to become ready, in milliseconds.                                                                                | Remote mode inherits `remote.timeoutMs`; if that is also unset, or in local mode, no readiness-wait limit is set. |
| Prompt-evolution search | `maxRounds` | Maximum logical attempts, including no-change and rejected attempts. | Required; no default. |
| Prompt-evolution search | `maxRollouts` | Task-rollout allowance across initial scoring, parent/proposal comparison, and population selection; separate from the evaluation-call budget. | Required; no default. |
| Optuna Proposer                                       | `python.timeoutMs`                                | Duration limit for one Python worker invocation, in milliseconds.                                                                                                     | No separate duration limit for a worker invocation.                                                               |
| Optuna Proposer                                       | `maxSamplingAttempts`                             | Maximum sampling attempts across the search, including duplicate combinations that skip evaluation; `policy.config.maxTrials` separately limits evaluations.          | No additional sampling-attempt limit.                                                                             |
| Reflection file                                       | `budget.modelCalls`                               | Maximum model requests for one Reflection call; 0 prevents the built-in generator from starting, and positive limits require backend accounting.                      | No model-call limit specific to this Reflection call.                                                             |
| Reflection file                                       | `budget.timeoutSeconds`                           | Duration limit for one Reflection call, in seconds.                                                                                                                   | No separate duration limit for this Reflection call.                                                              |
| Target                                                | `entries[].content.maxBytes`                      | Maximum content size per file in the Target entry, in bytes.                                                                                                          | The Target sets no per-file size limit.                                                                           |
| Target                                                | `constraints.maxChangedFiles`                     | Maximum changed files in one candidate commit.                                                                                                                        | The Target sets no changed-file count limit.                                                                      |
| Target                                                | `constraints.maxChangedBytes`                     | Maximum total content size of changed files in one candidate commit, in bytes.                                                                                        | The Target sets no total changed-content size limit.                                                              |
| Policy call step                                      | `steps[].with.editConstraints.maxChangedFiles`    | When supported by the contract, limit the number of files changed by this edit.                                                                                       | No additional per-edit file-count limit; existing constraints such as the Target still apply.                     |
| Policy call step                                      | `steps[].with.editConstraints.maxChangedBytes`    | When supported by the contract, limit the total changed-file content size for this edit, in bytes.                                                                    | No additional per-edit byte limit; existing constraints such as the Target still apply.                           |
| Policy call step                                      | `steps[].with.editConstraints.maxChangedSubtrees` | Maximum number of Target entries whose file or directory scopes a candidate edit may change.                                                                          | No limit on the number of Target entries affected by this edit.                                                   |
