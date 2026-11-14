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

Configure the optimization Agent and the evaluated system's Evaluator separately; their model settings are independent. Choose Pi to configure model access in the Recipe, or Codex, Claude Code or DSH to use an installed CLI.

### Environment variables

RSI does not automatically load `.env` files. Export variables in the process that launches the CLI. Native Agent CLIs may additionally load their own configuration or environment files according to their own rules.

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

InferenceBench runs the SDK locally for AgentX and AISBench. The AISBench solver connects to the load generator over SSH. Omitting `services` binds the candidate to the default service. For a named route, declare the service selected by `benchmark.solver.service`. That entry accepts SDK options such as `retry` and `contextWindow`. Supplying `model`, `base_url`, or `api_key` in that entry is an error. Configure the credential reference on the Application with `credentials.apiKeyEnv`. Other service entries follow the SDK requirements.

OperatorBench takes an SDK `kernel` benchmark and an RSI `task.directory`. After selecting the case, RSI builds and checks the final SDK configuration before acquiring the candidate. RSI supplies the service required for kernel replay. Omit `services` entirely, including empty maps. Put kernel options such as `repeat`, `python`, and `profiling` under `benchmark.config`. RSI builds the manifest from the candidate and reference, binds the selected case and seed, and stores the run index and output in the call directory. A `profile` action enables profiling and disables its cache. See the [operator Recipe](../../../examples/artifacts/kernel/transpose-copy/recipe.search.yaml).

### Choose and configure an Agent backend

Configure just one of the backends below. Pi uses the model settings in your Recipe; Codex, Claude Code, DSH and OpenCode call a CLI installed on the computer running RSI.

The YAML examples are **fragments of an existing Recipe**: replace `bindings.agent`, keeping your Application, Policy and other bindings. If a custom Policy uses a different Agent binding name, use that name instead. Agent settings do not configure the Evaluator's model.

### Pi backend

Replace `your-model`, endpoint URLs and keys with your own values. Set environment variables in **the same terminal that starts RSI**; RSI does not load `.env` automatically. The `export NAME='value'` examples use Bash/Zsh; in Windows PowerShell, write `$env:NAME = 'value'` instead.

No separate Pi CLI installation is needed. With an OpenAI Chat Completions endpoint available, set:

```sh
export MODEL_NAME='your-model'
export MODEL_ENDPOINT='https://api.example.com/v1'
export MODEL_API_KEY='your-api-key'
```

Windows PowerShell:

```powershell
$env:MODEL_NAME = 'your-model'
$env:MODEL_ENDPOINT = 'https://api.example.com/v1'
$env:MODEL_API_KEY = 'your-api-key'
```

In your Recipe:

```yaml
bindings:
  agent:
    plugin: agent.pi
    config:
      model: ${MODEL_NAME}
      base_url: ${MODEL_ENDPOINT}
      api_key: ${MODEL_API_KEY}
```

[Pi Schema](../../../src/plugins/agent-pi/schema.ts) defaults to `thinkingLevel: low`, `contextWindow: 262144`, and `retries: 0`. Set `maxTokens` for a per-request output limit; it must fit `contextWindow` and the endpoint's capabilities.

The default `bashMode: sandbox` requires macOS `sandbox-exec` or Linux `bubblewrap`. With an explicitly configured `bashMode: direct`, Bash runs with the host account's permissions and uses Pi's platform shell discovery, including Git Bash on Windows. Bash must be installed in a location Pi can discover.

- `api_key` must be an environment-variable reference, not a literal key.

- `timeoutMs` limits each model request. The underlying HTTP client uses a ten-minute request timeout when `timeoutMs` is omitted. Both timeout fields accept integer milliseconds from 1 to 2,147,483,647.
- `executionTimeoutMs` limits the complete Agent invocation, including model requests, tools, output correction, context compaction, retry waits, and awaited subagents. It does not reset between requests.

### Native CLI backends

- **You prepare the environment**: install or update your chosen CLI and select its Agent backend in the Recipe. Sign in or configure model access as the same system user that starts RSI, then verify the model through the CLI. Reuse existing settings without duplicating API addresses or keys in the Recipe.
- **RSI handles invocation**: start the CLI, prepare the task workspace, prompt and session, use native tools to read task files, validate the result, and clean up processes and temporary invocation files when the call ends. The Agent returns proposed changes for RSI to check and apply.

| Backend | Installation and configuration | Sign in or verify | Recipe `plugin` |
| --- | --- | --- | --- |
| Codex | [Official guide](https://developers.openai.com/codex/cli/) | Sign in with `codex login`, check with `codex login status`, then verify the model in `codex` | `agent.codex` |
| Claude Code | [Official guide](https://code.claude.com/docs/en/setup) | Sign in with `claude auth login`, check with `claude auth status`, then verify the model in `claude` | `agent.claudecode` |
| DSH | [Official guide](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/cli) | Configure the headless profile, then verify with `dsh --profile headless "Reply with OK."` | `agent.dsh` |
| OpenCode V2 | [Official guide](https://opencode.ai/docs/cli/); `npm install -g @opencode/cli` | Run `opencode` to configure and verify model access | `agent.opencode` |

For a custom model service, follow the CLI's official configuration instructions instead of account sign-in. Authentication status alone does not confirm model access: verify that the CLI can answer a message. DSH requires a working **headless** profile, not just Web UI configuration.

Then update the Agent binding in your Recipe, replacing `plugin` with your chosen backend from the table:

```yaml
bindings:
  agent:
    plugin: agent.codex
    config: {}
```

`config: {}` uses the native default model. Optional overrides for an experiment are:

| Backend | Optional settings |
| --- | --- |
| All | `executable`: full CLI path; `timeoutMs`: deadline in milliseconds for one Agent task |
| Codex | `model`, `thinkingLevel` |
| Claude Code | `model`, `effort` |
| DSH | Configure the model in the native headless profile |
| OpenCode | `model`: `provider/model`, optionally followed by `#variant` |

RSI keeps native model and authentication settings while limiting tasks to read-only proposals with no interactive approvals. Claude Code Hooks and MCP are disabled for RSI calls.

### Check and start

After configuring your chosen backend, replace the path below with your complete Recipe file and run these commands in the same terminal:

```sh
ember-rsi doctor path/to/recipe.yaml
ember-rsi run path/to/recipe.yaml
```

Resolve Doctor failures before running the experiment. `model-access: unchecked` does not confirm a working model connection: actual calls may still fail due to permissions, model names or API compatibility. See [Doctor](doctor.md) for check coverage.

When running from the source repository, replace `ember-rsi` with `pnpm ember-rsi`. If the native CLI cannot be found, open a new terminal or set `executable` to its full path under the binding's `config`.

For native CLI backends, add `timeoutMs: 180000` to limit each Agent task to 3 minutes; omitting it leaves that deadline unset. These backends cannot enforce `budget.modelCalls`. The Agent proposes changes for RSI to check and apply; configure prompts and Skills in the calling component, such as the Proposer.

## Inference optimization

For inference optimization, `evaluator.inferencebench` supports `benchmark.name: aisbench` with the bundled SSH solver, or `agentx` with the replay solver. Use the same benchmark workload for the baseline and candidate trials. The Runtime enforces the experiment-wide limits in the Recipe’s `budget`.

For `parameter.agent`, `policy.config.candidatesPerRound` defaults to 4 and accepts 1 through 6. The tuning Proposer returns that many candidates at most, ordered by priority and based on the same incumbent. The Policy invokes `evaluator.inferencebench` directly and serially, then uses the latest incumbent when requesting the next batch. `maxTrials` caps candidate attempts across all batches. Confirmed, cleaned startup failures reject the candidate; SDK measurement failures, cancellation or uncertain cleanup stop the experiment.

`policy.config.maxTrials` must be a positive integer (default 8). It also bounds
proposal rounds so repeated empty responses cannot create an unbounded loop.
A no-change proposal preserves its reason in `observations.previousNoChangeReason`
and requests another proposal from the same incumbent while limits permit. It
consumes a proposal round, not a candidate attempt, and does not restart the
baseline. Enabled Reflection also runs after an empty proposal when another
round and candidate attempt remain; Memory stays tied to measured batches.
Runtime time, operation and evaluation budgets, cancellation, errors and
unconfirmed cleanup remain independent stopping conditions. Policy `stopReason`
is `max-trials` when the candidate limit is reached, `max-proposal-rounds` when
the round limit is reached first, otherwise `null`. Budget exhaustion is recorded
at experiment level and preserves the last committed incumbent in `partialOutput`.

`parameter.agent` also supports independent `policy.config.memory` and
`policy.config.reflection` switches, both `false` by default. Memory consolidates
measured batches and passes the saved `memoryRef` to subsequent proposals;
Reflection revises only Proposer `guidance` between batches when another trial
can run. Both reuse the configured `agent` binding and `training-summary` evidence.
The Policy supplies generic Proposer, Memory and Reflection prompts, plus default
[guidance](../../../src/policies/parameter/agent/guidance/search.md). To specialize
that guidance, copy it to a dedicated directory and set
`bindings.proposer.config.guidance` to that directory. The Reflection switch only
controls invocation: its configuration and resources are validated at Recipe load
time even when the switch is false. Custom Proposers must expose the configured
Reflection target resources, or the Recipe must select a compatible Reflection file.
Scene-specific copies of prompts can be selected through
`bindings.proposer.config.prompt`, `bindings.memoryUpdater.config.prompt` and
`reflection.configFile`; they do not require a copy of the Policy.
The result includes `memoryRef` (`null` when absent).
See [Memory](memory.md) and [Reflection](reflection.md) for storage and activation.

This is reusable single-file configuration-search orchestration: objectives,
research methods and specialist roles come from the Recipe and its resources.
The evaluator binding still requires `contract.inferencebench`, and the selector
requires `contract.selector-metrics`; other evaluation contracts need a compatible
adapter or a different Policy.

The default `selector.inference` uses `metric` and `direction` for the primary objective, `constraints` for performance targets, with `prerequisite: true` marking hard requirements that run before objective comparison. It can accept reduced constraint violations before every target is met, while preventing regressions in satisfied constraints. See [Built-in components](built-in-components.md#loop-components) for the selection rules. The Policy retains the incumbent and reports `candidateFeasible` separately from whether a candidate was accepted.

With `application.inference.config.remote.discoverParameters: true`, the launcher reports its installed parameter catalog at initialization. Agent proposals receive the catalog in `context/input.json` as `target.parameterCatalog`. The vLLM Ascend example enables this feature and limits the catalog to an explicit performance-parameter allowlist; precision, quantization, speculative decoding, and structured configs are excluded.

## Proposer file edits

`proposer.agent` uses one Agent output schema for file edits. Each entry in `edits` has a path and an `op`. Use `replace` or `create` with full `content`, `patch` with exact `oldText` and `newText` in `changes`, or `delete` with only the path. A proposal can combine operations on different paths. The Proposer and Application enforce the edit constraints and Target permissions.

A `patch` must be the only operation for its path. Duplicate whole-file edits use the existing merge and conflict handling.

To migrate a custom Proposer prompt, remove `editProtocol` from the binding and give every edit an `op`. For whole-file edits, use `replace` for an existing file, `create` for a new file, and `delete` for a deletion. Existing tagged patch operations keep their fields.

## Limits and budgets

When an experiment budget is exhausted, the Runtime records `stopReason: budget-exhausted` and the limit in `budgetMetric`. Use `ember-rsi show <experiment-id>` to inspect the record. If the Policy output can be evaluated and validated from the last committed checkpoint, the record includes it as `partialOutput`. For `parameter.agent`, this retains the incumbent candidate and its measurement when available, even when `candidateFeasible` is false. Use the experiment record’s top-level `stopReason` to determine why the run ended.

Omitted Recipe binding settings first inherit Policy defaults. The “When omitted” column describes settings that remain unset; limits at other layers can still apply.

| Location                              | Setting                                            | Meaning                                                                                                                                                               | When omitted                                                                                                      |
| ------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Recipe                                | `budget.operations`                                | Maximum Runtime operation calls, including nested calls.                                                                                                              | No experiment-wide call limit.                                                                                    |
| Recipe                                | `budget.evaluationRuns`                            | Maximum evaluation calls; one call can cover several tasks. OperatorBench evaluation and profiling calls both count.                                                  | No experiment-wide evaluation-call limit.                                                                         |
| Recipe                                | `budget.modelCalls`                                | Maximum model requests charged by supported backends, including retries, output corrections, and subagents; does not limit benchmark Solver or native Codex, Claude Code, or DSH requests. | No experiment-wide model-call limit.                                                                              |
| Recipe                                | `budget.elapsedWallMs`                             | Maximum elapsed experiment time in milliseconds; resume includes time spent interrupted and does not restart the clock.                                               | No experiment-wide elapsed-time limit.                                                                            |
| Recipe                                | `budget.cleanupReserveMs`                          | Separate duration limit in milliseconds for cleanup, such as releasing instances and closing plugins.                                                                 | No Runtime cleanup deadline.                                                                                      |
| Pi                                    | `maxTokens`                                        | Maximum output tokens per model request.                                                                                                                              | Omit the output-token limit from the request; the model service decides.                                          |
| Pi                                    | `contextWindow`                                    | Context-window size in tokens used by Pi for context management; match it to the model's capabilities.                                                                | 262144 tokens.                                                                                                    |
| Pi                                    | `timeoutMs`                                        | Duration limit per model request, in milliseconds.                                                                                                                    | The underlying HTTP client uses 600000 ms (10 minutes).                                                           |
| Pi                                    | `executionTimeoutMs`                               | Duration limit for a complete Agent call in milliseconds, including requests, tools, compaction, retry waits, and subagents.                                          | No separate duration limit for the complete call.                                                                 |
| Codex / Claude Code / DSH | `timeoutMs`                                        | Duration limit for the complete Agent call, in milliseconds.                                                                                                          | RSI sets no separate timeout for the call.                                                                        |
| Operator Proposer                     | `modelRequestTimeoutMs`                            | Shared duration limit for a complete model stage in milliseconds, including tool continuations and delegated Agents.                                                  | 120000 ms (2 minutes).                                                                                            |
| AgentBench Evaluator                  | `services.<service>.maxTokens`                     | Per-turn output-token limit for the model service used by the evaluated Agent.                                                                                        | Determined by Solver or model-service defaults.                                                                   |
| AgentBench / InferenceBench Evaluator | `run.timeoutSeconds`                               | Duration limit for one benchmark task attempt, in seconds.                                                                                                            | Use the SDK benchmark profile's value; fall back to 7200 seconds (2 hours) if the profile omits it.               |
| OperatorBench Evaluator               | `benchmark.config.timeoutSeconds`                  | Duration limit for one kernel evaluation or profiling operation, in seconds.                                                                                          | 300 seconds, or `maxAttempts × attemptTimeoutSeconds + 300` when profiling is enabled.                            |
| OperatorBench Evaluator               | `benchmark.config.profiling.attemptTimeoutSeconds` | Duration limit for an individual profiling attempt, in seconds.                                                                                                       | SDK default: 300 seconds (5 minutes).                                                                             |
| Inference Application                 | `remote.timeoutMs`                                 | Duration limit for one remote-script invocation, in milliseconds.                                                                                                     | No separate duration limit for the remote call.                                                                   |
| Inference Application                 | `healthcheck.timeoutMs`                            | Duration limit for waiting for the inference service to become ready, in milliseconds.                                                                                | Remote mode inherits `remote.timeoutMs`; if that is also unset, or in local mode, no readiness-wait limit is set. |
| Pareto Evolution Proposer             | `maxRounds`                                        | Maximum logical attempts, including no-change and rejected attempts.                                                                                                  | Required; no default.                                                                                             |
| Pareto Evolution Proposer             | `maxRollouts`                                      | Task-rollout allowance across initial scoring, parent/proposal comparison, and population selection; separate from the evaluation-call budget.                        | Required; no default.                                                                                             |
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

Codex calls with native expert roles retain their parent rollout so full-context delegation can fork it. Calls without roles remain ephemeral. Search behavior follows the native Codex configuration.
