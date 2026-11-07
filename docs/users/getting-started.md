# Getting started

English | [简体中文](getting-started_zh.md)

Before starting, read [Architecture and core concepts](concepts/architecture.md) to understand the framework's main concepts and how they relate.

This tutorial shows how to configure an Application, choose a built-in Policy, and write and run a Recipe through an experiment that improves terminal-task skills.

- An Application defines and manages the optimization target.
- A Policy orchestrates improvement steps such as proposal, evaluation, and selection.
- A Recipe combines the two with plugins, parameters, and budgets to configure an experiment.

## 0. Install and prepare the environment

Use Node.js 24 (at least 24.19.0), pnpm 11.22.0, Git, and access to the pinned Git dependencies. **Run these commands from the source checkout**:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm add -g .

pnpm ember-rsi --help
```

AgentBundle and the Evaluator SDK build during installation; sibling checkouts are not required. See the [repository setup instructions](../../README.md) for cloning and platform-specific setup.

- Before a real run, prepare Docker, TerminalBench 4.0 tasks and images, and a model endpoint reachable from both the host and the evaluation containers. The [WikiSkill example](../../examples/harness/dsh-wikiskill/README.md) describes the benchmark setup.

## 1. Define the Application

> The following example uses the built-in Application `application.agentbundle`. If you use another Application, first consult its configuration documentation and configuration Schema to determine what to put in the Recipe's `application.plugin` and `application.config` fields.

This example uses it to optimize an Agent Harness. Configure two inputs.

- **Baseline** supplies the Agent Bundle at the start of the experiment.
- **Target** defines which file changes the Application can accept.

### Baseline

The Baseline is the working version of the Agent you want to improve.

- When the experiment starts, `application.agentbundle` takes a snapshot of the Baseline directory, validates the Bundle and its skills, and registers the snapshot as the first candidate.

Run these commands from the repository root to copy the WikiSkill Bundle into your experiment directory.

```sh
mkdir -p my-experiment
cp -R examples/harness/dsh-wikiskill/baseline my-experiment/
```

The copied `my-experiment/baseline/` directory contains these files.

```text
baseline/
├── bundle.yaml
├── agent.yaml
├── dependencies.lock
└── plugins/terminal-base/
    ├── package.json
    ├── index.js
    ├── cordis.patch.yml
    └── prompts/baseline.md
```

This baseline starts with an empty prompt and no skills. The optimization flow can create `skills/<name>/SKILL.md` under `plugins/terminal-base/`, and the baseline loader adds those skills to the evaluated Agent's system prompt.

The [`bundle.yaml` manifest](../../examples/harness/dsh-wikiskill/baseline/bundle.yaml) declares the Harness, the Agent's entry configuration, and the local plugins to load.

```yaml
schemaVersion: 1
name: dsh-wikiskill-baseline
kind: dsh-agent-bundle
harness:
  name: dsh
  version: '>=0.1.6-alpha.1 <0.2'
plugins:
  - path: plugins/terminal-base
entry: agent.yaml
lockfile: dependencies.lock
```

To prepare your own Baseline, put the original Agent Bundle's manifest, entry configuration, lockfile, and plugins in one directory.

### Target

The Target defines the scope of changes allowed during optimization: which files or directories can change, which files can be created, modified, or deleted, and the limits on file size and total changes. The example below creates `my-experiment/target.yaml`:

- The Application validates the rules when committing a candidate and rejects changes that violate them.

```yaml
schemaVersion: rsi.target/v1
id: target.my-terminal-skills
entries:
  # This example allows creating, modifying, or deleting only each skill's `SKILL.md` under `plugins/terminal-base/skills/` in the Baseline.
  - path: plugins/terminal-base/skills
    kind: directory
    description: Reusable skills loaded by the evaluated terminal Agent.
    include: ['*/SKILL.md']
    changes: [create, modify, delete]
    content: { encoding: utf-8, minBytes: 1, maxBytes: 65536 }
constraints:
  maxChangedFiles: 4
  maxChangedBytes: 131072
```

## 2. Write the Recipe and choose a built-in Policy

> For a more detailed guide to writing Recipes, see the [configuration guide](guides/configuration.md).

This section defines the experiment configuration. Save the following content as `my-experiment/recipe.yaml`, alongside `target.yaml` and `baseline/`.

- This example uses `policy.wikiskill` to learn from training tasks, evaluate the Baseline and any changed candidate on validation tasks, and evaluate the test tasks after the search.

- If the built-in Policies do not meet your workflow needs, follow [Write a Policy](guides/writing-policies.md) to define and register a custom Policy, then reference it through the Recipe's `policy.id`.

```yaml
schemaVersion: rsi.recipe/v1
id: my-terminal-skills
application:
  plugin: application.agentbundle
  config:
    target: { schema: ./target.yaml }
    baseline: { directory: ./baseline }
policy:
  id: policy.wikiskill
  input:
    candidateRef: ${{ application.initialCandidate }}
  config:
    maxRounds: 1
    dataset:
      trainTaskIds: [terminal-bench/html-js-filter]
      validationTaskIds: [terminal-bench/formal-crypto]
      testTaskIds: [terminal-bench/bun-sourcemap-leak]
bindings:
  agent:
    plugin: agent.pi
    config:
      timeoutMs: 1800000
      executionTimeoutMs: 3600000
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
      environment:
        platform: linux/amd64
      scheduler:
        name: local
        concurrency: 1
      run:
        timeoutSeconds: 3600
budget:
  operations: 100
  evaluationRuns: 4
  modelCalls: 100
  elapsedWallMs: 21600000
  cleanupReserveMs: 60000
```

| Fields in the example | Usage                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`, `id` | Use `rsi.recipe/v1`; `id` names the Recipe. Use CLI `--id` to identify a particular experiment run.                                                                                                                                                                                                                                                                                  |
| `application`         | Set `plugin` to a registered Application ID and use its configuration Schema for `config`.<br>Target and baseline paths in the example are relative to the Recipe file.                                                                                                                                                                                                              |
| `policy`              | Set `id` to a registered Policy ID. Use `config` for Policy parameters and `input` for initial values.                                                                                                                                                                                                                                                                               |
| `bindings`            | Specify the plugins the Policy calls and their configuration.<br>The Policy in this example supplies default bindings for Agent, Proposer, Memory, and Selector implementations. The Recipe adds Agent and Evaluator settings to customize their plugin configuration. When the plugin stays the same, objects merge recursively; arrays, scalars, and null replace previous values. |
| `budget`              | Set experiment limits for call counts and elapsed time. See the fields and defaults below.                                                                                                                                                                                                                                                                                           |

A supported plugin field can use `${NAME}` for an environment reference. That syntax differs from a Runtime expression such as `${{ application.initialCandidate }}`.

### Budget

The Recipe lists all five built-in Runtime budget fields.

| Field              | What it limits                                                                                                                                                                               | When omitted                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `operations`       | Operation calls handled by the Runtime, including Application initialization, plugin calls, and nested calls.<br>One Policy iteration can trigger several operations.                        | No limit for this field     |
| `evaluationRuns`   | Evaluator runs. A run can cover multiple tasks.<br/>This example allows up to four runs for Baseline validation, training evaluation, validation of a changed candidate, and the final test. | No limit for this field     |
| `modelCalls`       | Requests charged by accounting-capable Agent backends, including Pi corrections and subagents.<br/>Note: Evaluator Solver requests are accounted separately.                                 | No limit for this field     |
| `elapsedWallMs`    | Time allowed for experiment execution in milliseconds.<br/>On resume, the Runtime calculates the remaining time from the original start time, including downtime.                            | No Runtime wall-time limit  |
| `cleanupReserveMs` | Time in milliseconds to wait for cleanup such as releasing instances and shutting down plugins.                                                                                              | No Runtime cleanup deadline |

A custom plugin can use `context.charge(metric, amount)` to record its own metric and set a limit under the same key in `budget`.

- For more details, see the [Manager's accounting and timeout logic](../../src/runtime/manager/index.ts).

## 3. Validate, run, and inspect

Before running the experiment, prepare Docker, benchmark tasks, images, and model access. Follow the [WikiSkill example](../../examples/harness/dsh-wikiskill/README.md).

Set the following variables in the shell that launches RSI. The example below uses Bash; in PowerShell, use `$env:NAME = 'value'` for each variable:

```sh
export MODEL_NAME="your-optimizer-model"
export EVALUATOR_MODEL_NAME="your-solver-model"
export MODEL_ENDPOINT="https://your-model-service.example/v1"
export MODEL_API_KEY="your-api-key"
```

- RSI does not load `.env` files automatically.

- This tutorial uses `MODEL_NAME` for the optimizer and `EVALUATOR_MODEL_NAME` for the evaluated Solver. The checked-in WikiSkill Recipe uses `MODEL_NAME` for both; the Harness² Recipe separates them. See [Agent and environment variables](guides/configuration.md#environment-variables).

```sh
ember-rsi catalog # List registered IDs
ember-rsi validate my-experiment/recipe.yaml # Check configuration, contracts, and bindings
ember-rsi run my-experiment/recipe.yaml --id terminal-skills-01 # Run the experiment
ember-rsi show terminal-skills-01 # Inspect the saved status and results
```

- Use `ember-rsi list` to find saved experiments.
- Use `ember-rsi cancel terminal-skills-01` to request cancellation.
- Use `ember-rsi validate my-experiment/recipe.yaml` to check schemas, bindings, contracts, and declared Reflection resources. This command does not make model requests or prepare the benchmark.
- Use `ember-rsi run my-experiment/recipe.yaml --id terminal-skills-01 --resume` to resume an interrupted experiment, reusing the original Recipe, working directory, and experiment ID.
- Use `ember-rsi dashboard --port <port>` to inspect candidates, measurements, and calls. Run it from the same working directory containing `.rsi/` and open the address printed by the command. The `Reflection & Memory` tab also lets you inspect experience and revisions, and preview and apply Reflection changes; see [Dashboard](guides/running-experiments.md#dashboard). Start, resume, and cancel through the CLI.

Inspect the saved experiment status, Measurement status and coverage, and scores separately after a run. See [running and troubleshooting experiments](guides/running-experiments.md).

## Next steps

- [Understand how a Recipe runs](concepts/architecture.md) and how the Runtime coordinates the Application, Policy, and plugins.
- [Choose a built-in Policy and its components](guides/built-in-components.md) for your optimization target and evaluation setup.
- [Configure experiments](guides/configuration.md), including Recipe fields, plugin bindings, Agents, environment variables, and budgets.
- [Run, observe, and recover experiments](guides/running-experiments.md) with the CLI and dashboard.
- [Use Skills](guides/using-skills.md) with your personal coding Agent, the evaluated Agent, or the optimizer.
- [Configure Memory](guides/memory.md) to consolidate execution experience and pass it to later optimization calls.
- [Configure Reflection](guides/reflection.md) to improve plugins using execution evidence and use plugin revisions in the current or future experiments.
- Tune inference service parameters with the [grid](../../examples/artifacts/inference/parameter-grid/README.md) or [Optuna](../../examples/artifacts/inference/parameter-tpe/README.md) example.
- Optimize Triton-Ascend kernels with the [operator optimization example](../../examples/artifacts/kernel/transpose-copy/README.md), including NPU setup, Recipe fields, and evaluation configuration.
- [Write a Policy](guides/writing-policies.md) to change the experiment flow or stopping rules.
- [Write and register a plugin](guides/writing-plugins.md) for a Policy to call.
- [Subscribe to or publish Runtime events](guides/runtime-events.md) from an extension.
