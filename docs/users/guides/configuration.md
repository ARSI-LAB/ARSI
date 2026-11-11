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

Evaluator plugins use the installed Evaluator SDK's configuration types and parser. RSI binds the candidate, selected tasks, and per-call output directory, then writes the SDK-parsed configuration before charging the evaluation budget. Use environment references for credentials. The SDK applies defaults and validates benchmark-specific options when evaluation starts. An error at that stage consumes one `evaluationRuns` charge.

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

AgentBench binds the candidate Bundle to the `agentbundle` solver and replaces sampling, offset, and task-count limits with the Policy's explicit task IDs.

When the optimizer needs the public task prompt, set `run.includeTaskAnswer: true` in the Evaluator configuration so the SDK records task data. RSI publishes the public prompt as `task-input` execution evidence for later plugins; reference answers remain in private native records.

InferenceBench requires local AgentX execution. Omitting `services` binds the candidate to the default service. For a named route, declare the service selected by `benchmark.solver.service`. That entry accepts SDK options such as `retry` and `contextWindow`. Supplying `model`, `base_url`, or `api_key` in that entry is an error. Configure the credential reference on the Application with `credentials.apiKeyEnv`. Other service entries follow the SDK requirements.

OperatorBench takes an SDK `kernel` benchmark and an RSI `task.directory`. After selecting the case, RSI builds and checks the final SDK configuration before acquiring the candidate. RSI supplies the service required for kernel replay. Omit `services` entirely, including empty maps. Put kernel options such as `repeat`, `python`, and `profiling` under `benchmark.config`. RSI builds the manifest from the candidate and reference, binds the selected case and seed, and stores the run index and output in the call directory. A `profile` action enables profiling and disables its cache. See the [operator Recipe](../../../examples/artifacts/kernel/transpose-copy/recipe.search.yaml).

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

`bashMode` defaults to `sandbox`, using bubblewrap on Linux and sandbox-exec on macOS. Set `bashMode: direct` explicitly to run bash in the project directory with the host account's file and process permissions. This mode supports environments that cannot create sandbox namespaces. The read, edit, and write tools continue to validate their paths.

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

## Proposer file edits

`proposer.agent` uses one Agent output schema for file edits. Each entry in `edits` has a path and an `op`. Use `replace` or `create` with full `content`, `patch` with exact `oldText` and `newText` in `changes`, or `delete` with only the path. A proposal can combine operations on different paths. The Proposer and Application enforce the edit constraints and Target permissions.

A `patch` must be the only operation for its path. Duplicate whole-file edits use the existing merge and conflict handling.

To migrate a custom Proposer prompt, remove `editProtocol` from the binding and give every edit an `op`. For whole-file edits, use `replace` for an existing file, `create` for a new file, and `delete` for a deletion. Existing tagged patch operations keep their fields.

## Limits and budgets

Omitted Recipe binding settings first inherit Policy defaults. The “When omitted” column describes settings that remain unset; limits at other layers can still apply.

| Location                              | Setting                                            | Meaning                                                                                                                                                               | When omitted                                                                                                      |
| ------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Recipe                                | `budget.operations`                                | Maximum Runtime operation calls, including nested calls.                                                                                                              | No experiment-wide call limit.                                                                                    |
| Recipe                                | `budget.evaluationRuns`                            | Maximum evaluation calls; one call can cover several tasks. OperatorBench evaluation and profiling calls both count.                                                  | No experiment-wide evaluation-call limit.                                                                         |
| Recipe                                | `budget.modelCalls`                                | Maximum model requests charged by supported backends, including retries, output corrections, and subagents; does not limit benchmark Solver or native Codex requests. | No experiment-wide model-call limit.                                                                              |
| Recipe                                | `budget.elapsedWallMs`                             | Maximum elapsed experiment time in milliseconds; resume includes time spent interrupted and does not restart the clock.                                               | No experiment-wide elapsed-time limit.                                                                            |
| Recipe                                | `budget.cleanupReserveMs`                          | Separate duration limit in milliseconds for cleanup, such as releasing instances and closing plugins.                                                                 | No Runtime cleanup deadline.                                                                                      |
| Pi                                    | `maxTokens`                                        | Maximum output tokens per model request.                                                                                                                              | Omit the output-token limit from the request; the model service decides.                                          |
| Pi                                    | `contextWindow`                                    | Context-window size in tokens used by Pi for context management; match it to the model's capabilities.                                                                | 262144 tokens.                                                                                                    |
| Pi                                    | `timeoutMs`                                        | Duration limit per model request, in milliseconds.                                                                                                                    | The underlying HTTP client uses 600000 ms (10 minutes).                                                           |
| Pi                                    | `executionTimeoutMs`                               | Duration limit for a complete Agent call in milliseconds, including requests, tools, compaction, retry waits, and subagents.                                          | No separate duration limit for the complete call.                                                                 |
| Codex                                 | `timeoutMs`                                        | Duration limit for the complete Agent call, in milliseconds.                                                                                                          | RSI sets no separate timeout for the call.                                                                        |
| Operator Proposer                     | `modelRequestTimeoutMs`                            | Shared duration limit for a complete model stage in milliseconds, including tool continuations and delegated Agents.                                                  | 120000 ms (2 minutes).                                                                                            |
| AgentBench Evaluator                  | `services.<service>.maxTokens`                     | Per-turn output-token limit for the model service used by the evaluated Agent.                                                                                        | Determined by Solver or model-service defaults.                                                                   |
| AgentBench / InferenceBench Evaluator | `run.timeoutSeconds`                               | Duration limit for one benchmark task attempt, in seconds.                                                                                                            | Use the SDK benchmark profile's value; fall back to 7200 seconds (2 hours) if the profile omits it.               |
| OperatorBench Evaluator               | `benchmark.config.timeoutSeconds`                  | Duration limit for one kernel evaluation or profiling operation, in seconds.                                                                                          | 300 seconds, or `maxAttempts × attemptTimeoutSeconds + 300` when profiling is enabled.                            |
| OperatorBench Evaluator               | `benchmark.config.profiling.attemptTimeoutSeconds` | Duration limit for an individual profiling attempt, in seconds.                                                                                                       | SDK default: 300 seconds (5 minutes).                                                                             |
| Inference Application                 | `remote.timeoutMs`                                 | Duration limit for one remote-script invocation, in milliseconds.                                                                                                     | No separate duration limit for the remote call.                                                                   |
| Inference Application                 | `healthcheck.timeoutMs`                            | Duration limit for waiting for the inference service to become ready, in milliseconds.                                                                                | Remote mode inherits `remote.timeoutMs`; if that is also unset, or in local mode, no readiness-wait limit is set. |
| Prompt-evolution search               | `maxRounds`                                        | Maximum logical attempts, including no-change and rejected attempts.                                                                                                  | Required; no default.                                                                                             |
| Prompt-evolution search               | `maxRollouts`                                      | Task-rollout allowance across initial scoring, parent/proposal comparison, and population selection; separate from the evaluation-call budget.                        | Required; no default.                                                                                             |
| Optuna Proposer                       | `python.timeoutMs`                                 | Duration limit for one Python worker invocation, in milliseconds.                                                                                                     | No separate duration limit for a worker invocation.                                                               |
| Optuna Proposer                       | `maxSamplingAttempts`                              | Maximum sampling attempts across the search, including duplicate combinations that skip evaluation; `policy.config.maxTrials` separately limits evaluations.          | No additional sampling-attempt limit.                                                                             |
| Reflection file                       | `budget.modelCalls`                                | Maximum model requests for one Reflection call; 0 prevents the built-in generator from starting, and positive limits require backend accounting.                      | No model-call limit specific to this Reflection call.                                                             |
| Reflection file                       | `budget.timeoutSeconds`                            | Duration limit for one Reflection call, in seconds.                                                                                                                   | No separate duration limit for this Reflection call.                                                              |
| Target                                | `entries[].content.maxBytes`                       | Maximum content size per file in the Target entry, in bytes.                                                                                                          | The Target sets no per-file size limit.                                                                           |
| Target                                | `constraints.maxChangedFiles`                      | Maximum changed files in one candidate commit.                                                                                                                        | The Target sets no changed-file count limit.                                                                      |
| Target                                | `constraints.maxChangedBytes`                      | Maximum total content size of changed files in one candidate commit, in bytes.                                                                                        | The Target sets no total changed-content size limit.                                                              |
| Policy call step                      | `steps[].with.editConstraints.maxChangedFiles`     | When supported by the contract, limit the number of files changed by this edit.                                                                                       | No additional per-edit file-count limit; existing constraints such as the Target still apply.                     |
| Policy call step                      | `steps[].with.editConstraints.maxChangedBytes`     | When supported by the contract, limit the total changed-file content size for this edit, in bytes.                                                                    | No additional per-edit byte limit; existing constraints such as the Target still apply.                           |
| Policy call step                      | `steps[].with.editConstraints.maxChangedSubtrees`  | Maximum number of Target entries whose file or directory scopes a candidate edit may change.                                                                          | No limit on the number of Target entries affected by this edit.                                                   |

### Operator execution controls

The operator Policy defaults to 3 static attempts, 3 repairs per candidate, 10 metrics rounds, 5 valid candidates without promotion, and 3 consecutive empty metric proposals. Configure `maxAttempts`, `repairLimit`, `maxRounds`, `maxNoImprovement`, and `maxConsecutiveNoChange` in `policy.config`; these defaults are not Schema ceilings. A candidate resets the consecutive-empty count even if it is not promoted. A metric diagnosis with `status: no-new-hypothesis` skips retrieval and generation, records the round summary, and stops metric search immediately. The stop reasons are `no-new-hypothesis` and `consecutive-no-change`; both retain the incumbent and still run the independent final assessment. Results expose `consecutiveNoChangeCount` separately from `noImprovementCount`. The Proposer adds no per-stage model-call ceiling. Explicit Recipe model-call budgets still include delegated requests and tool continuations.

Metrics diagnosis returns either `status: hypothesis` with `category`, `summary`, `reasoning`, `rootCause`, `recommendedFix`, and exact profile `evidence`, or `status: no-new-hypothesis` with `reason`. Generation submits a plausible, contract-preserving candidate for formal evaluation without requiring a proven speedup or selecting it through local timing sweeps. Stored history keeps program-owned facts separate from model guidance. Each item in `lessons`, `avoidPatterns`, and `tryPatterns` has `text` and `basis`: `evaluation` for observations backed by the attempt's formal measurements, `agent-report` for unverified Agent accounts, or `hypothesis` for inferences and future tests. A round without candidate measurements cannot claim evaluation-backed guidance; invalid summary output is recorded as unavailable. Advisory reports and hypotheses must not become blanket technique bans or prerequisites for every future proposal.

| Configuration                                                                   | Meaning                                                                                                                                               |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bindings.proposer.config.modelRequestTimeoutMs`                                | Complete Proposer Agent stage timeout in milliseconds; default `120000`, `0` disables this local deadline. Parent cancellation still applies.         |
| `bindings.proposer.config.embedding.timeoutMs`                                  | Retrieval worker timeout in milliseconds; default `300000`, `0` disables this local deadline. CPU thread settings are inherited from the environment. |
| `bindings.proposer.config.embedding.maxPayloadBytes`                            | Optional maximum bytes for each retrieval request, response, or identity/knowledge JSON file. Omitted means no Proposer byte ceiling.                 |
| `bindings.proposer.config.embedding.maxLogBytes`                                | Optional maximum bytes per retrieval stdout/stderr stream. Omitted means no Proposer log ceiling.                                                     |
| `bindings.proposer.config.historyWindow`                                        | Recent summaries delivered to diagnosis and generation; default `5`, configurable without the former upper bound of 10.                               |
| `bindings.evaluator.config.benchmark.config.warmup`, `repeat`                   | Positive iteration counts, without the former 10,000/4,096 ceilings.                                                                                  |
| `bindings.evaluator.config.run.timeoutSeconds`                                  | Optional outer SDK run timeout. The worker timeout is configured independently through `benchmark.config.timeoutSeconds`.                             |
| `bindings.evaluator.config.benchmark.config.outputLimitBytes`                   | Optional complete kernel-process output limit. Omitted means unbounded protocol output; exceeding an explicit limit fails the run.                    |
| `bindings.evaluator.config.benchmark.config.cleanupGraceMs`, `cleanupTimeoutMs` | Optional positive process stop-grace and cleanup-confirmation times, in milliseconds. Cleanup must still be confirmed.                                |
| `bindings.evaluator.config.benchmark.config.profiling.cacheMaxEntries`          | Optional profile-cache capacity. Omitted means no entry-count eviction.                                                                               |
| `bindings.evaluator.config.benchmark.config.profiling.retryDelayMs`             | Optional delay in milliseconds between profiling retries; `0` retries without delay. Omission retains exponential backoff.                            |

The SDK controls above require the matching kernel Evaluator implementation. Timeout and cleanup values that create Node timers must fit their representation (`2147483647` milliseconds); the SDK splits profiling retry waits into valid timer chunks. These platform semantics are distinct from optimization budgets. The Target owns file and edit byte limits, and the Proposer no longer imposes its own 32 KiB source ceiling. JSON evidence reads default to a 60,000-byte summary, accept a caller's larger `maxBytes`, and obey explicit scope limits. File projections retain complete authorized sources unless an explicit byte limit is supplied; summaries remain derived views. Type, path, ownership, score-range and single-case protocol checks remain in effect.
