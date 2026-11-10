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

Agents in the optimization flow generate proposals, review deliverables, consolidate experience, and perform other model tasks. The built-in backends are Pi, Codex, and Claude Code. Evaluator settings are separate from the optimization Agent: AgentBench configures the evaluated Agent's (Solver's) model services, InferenceBench configures inference service benchmarks, and OperatorBench configures kernel evaluation environments.

All backends run in the workspace prepared for the Agent call. The `contract.agent` input supplies `cwd`, `goal`, and `outputSchema`, with `role` for Pi delegation through the Runtime. Codex and Claude Code delegate through native tools. Backends read instructions from `AGENTS.md` or `CLAUDE.md` and use the workspace files for task context.

| Configuration target  | Purpose                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Evaluator             | Configure model services, tasks, or execution environments for the selected benchmark.                              |
| Pi (`agent.pi`)       | Call a specified model service through Pi to execute Agent tasks in the optimization flow.                          |
| Codex (`agent.codex`) | Execute Agent tasks in the optimization flow through a local Codex installation, using its login and configuration. |
| Claude Code (`agent.claudecode`) | Execute Agent tasks using native Claude Code tools and structured output.                                           |
| DSH (`agent.dsh`) | Execute Agent tasks through the official DSH headless CLI and native configuration. |

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

OperatorBench takes an SDK `kernel` benchmark and an RSI `task.directory`. After selecting the case, RSI builds and checks the final SDK configuration before acquiring the candidate. RSI supplies the service required for kernel replay. Omit `services` entirely, including empty maps. Put kernel options such as `repeat`, `python`, and `profiling` under `benchmark.config`. RSI builds the manifest from the candidate and reference, binds the selected case and seed, and stores the run index and output in the call directory. A `profile` action enables profiling and disables its cache. When migrating an existing Recipe, move kernel options from `protocol` and `sdk` to `benchmark.config`, remove `mode` and `protocol.timingScope`, and set `run.onError: abort` and `run.timeoutSeconds` to the former kernel timeout plus 30 seconds to preserve the previous run settings. See the [operator Recipe](../../../examples/artifacts/kernel/transpose-copy/recipe.search.yaml).

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

### Claude Code backend

`agent.claudecode` uses a locally installed Claude Code CLI (2.1.319 or newer, macOS/Linux). Prepare its login or gateway environment before running RSI:

```yaml
bindings:
  agent:
    plugin: agent.claudecode
    config: {}
```

The [Claude Code Schema](../../../src/plugins/agent-claudecode/schema.ts) accepts `executable` (default `claude`), optional `model`, `effort`, and `timeoutMs` for the whole call. Unlike Codex's `thinkingLevel`, this backend uses `effort` for reasoning strength. Authentication and model connections remain configured in the native client environment.

Each call uses a fresh session, native Skills and subagents, and read-only tools; RSI applies the structured edit proposal. User/project settings, ordinary Hooks and MCP are disabled. These tool restrictions are not an OS sandbox and do not override administrator-managed Hooks. The backend cannot enforce `modelCalls` budgets.

### DSH backend

`agent.dsh` runs the installed official DSH CLI in headless mode. Install a release supporting `--json`, stdin tasks, `--permission-mode`, and `--approval-policy` (verified with `0.2.2-rc.1`). RSI does not install or upgrade DSH automatically.

```yaml
bindings:
  agent:
    plugin: agent.dsh
    config:
      executable: dsh
      timeoutMs: 180000
```

The [DSH Schema](../../../src/plugins/agent-dsh/schema.ts) accepts `executable` (default `dsh`) and optional `timeoutMs` for the complete call. Model routes and reasoning settings remain in the user's DSH headless profile. RSI inherits the launch environment and `DSH_HOME`; an invocation-only overlay restores the native credential store, authorization, and account plugins that upstream headless disables by default. It does not rewrite user configuration. API keys remain in native configuration or environment references, never Recipe fields.

Each invocation starts a fresh native session in the supplied Agent project. DSH retains native session logs. RSI supplies project instruction discovery and the `.agents/skills` path; native DSH subagents can read the generated `roles/<name>.md`. Direct `AgentInput.role` delegation is unsupported, as with Codex.

The CLI runs with `workspace-write` and `approval-policy never`: the whole task workspace is writable, **not only `candidate/` and `scratch/`**. Native DSH may also permit platform temporary directories. Requests requiring human approval are rejected. User-installed plugins retain their own behavior; this adapter does not provide an additional OS sandbox. Candidate submission still passes through RSI's Application validation.

Success requires both exit code zero and a completed native final event, followed by JSON Schema validation. Invalid final JSON fails without a correction turn or automatic rerun. RSI records session IDs and available per-step native token usage; missing usage stays unknown, and internal `modelCalls` budgets cannot be enforced. Raw model/tool output and stderr are not copied to RSI diagnostics; inspect native DSH logs for detailed failures.

Timeout, cancellation, and disposal terminate the process group on macOS/Linux. Windows is unsupported. This backend has been live-tested on macOS only.


## Proposer file edits

`proposer.agent` uses one Agent output schema for file edits. Each entry in `edits` has a path and an `op`. Use `replace` or `create` with full `content`, `patch` with exact `oldText` and `newText` in `changes`, or `delete` with only the path. A proposal can combine operations on different paths. The Proposer and Application enforce the edit constraints and Target permissions.

A `patch` must be the only operation for its path. Duplicate whole-file edits use the existing merge and conflict handling.

To migrate a custom Proposer prompt, remove `editProtocol` from the binding and give every edit an `op`. For whole-file edits, use `replace` for an existing file, `create` for a new file, and `delete` for a deletion. Existing tagged patch operations keep their fields.

## Limits and budgets

Omitted Recipe binding settings first inherit Policy defaults. The “When omitted” column describes settings that remain unset; limits at other layers can still apply.

| Location                                              | Setting                                           | Meaning                                                                                                                                                               | When omitted                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Recipe                                                | `budget.operations`                               | Maximum Runtime operation calls, including nested calls.                                                                                                              | No experiment-wide call limit.                                                                                    |
| Recipe                                                | `budget.evaluationRuns`                           | Maximum evaluation calls; one call can cover several tasks. OperatorBench evaluation and profiling calls both count.                                                  | No experiment-wide evaluation-call limit.                                                                         |
| Recipe                                                | `budget.modelCalls`                               | Maximum model requests charged by supported backends, including retries, output corrections, and subagents; does not limit benchmark Solver or native Codex, Claude Code, or DSH requests. | No experiment-wide model-call limit.                                                                              |
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
| OperatorBench Evaluator                               | `benchmark.config.timeoutSeconds`                 | Duration limit for one kernel evaluation or profiling operation, in seconds.                                                                                          | 300 seconds, or `maxAttempts × attemptTimeoutSeconds + 300` when profiling is enabled.                            |
| OperatorBench Evaluator                               | `benchmark.config.profiling.attemptTimeoutSeconds` | Duration limit for an individual profiling attempt, in seconds.                                                                                                       | SDK default: 300 seconds (5 minutes).                                                                             |
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
