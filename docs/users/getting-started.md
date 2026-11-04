# Getting started

English | [简体中文](getting-started_zh.md)

> Install dependencies, build ember-rsi, and install its CLI before following this example. See the [repository setup instructions](../../README.md).

This example walks through defining an Application, limiting which files it can edit, and writing a Recipe that uses a built-in Policy to improve terminal-task skills.

pnpm installs and builds the Evaluator SDK from the pinned `ember-evaluator` dependency. The same name is used for imports. See the [package manifest](../../package.json).

## 1. Define the Application

Use the built-in `application.agentbundle` to optimize an Agent Harness. Configure two inputs.

- **Baseline** supplies the Agent Bundle at the start of the experiment.
- **Target** defines which file changes the Application can accept.

### Baseline

The Baseline is the working version of the Agent you want to improve. When the experiment starts, `application.agentbundle` takes a snapshot of the Baseline directory, validates the Bundle and its skills, and registers the snapshot as the first candidate.

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
    ├── prompts/terminal-discipline.md
    └── skills/completion-checks/SKILL.md
```

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

To prepare your own Baseline, put the original Agent Bundle's manifest, entry configuration, lockfile, and plugins in one directory. Check that the manifest's relative paths exist and that the plugins load the prompts or skills you want to improve. Set `application.config.baseline.directory` to that directory, relative to `recipe.yaml`. If you already have an accessible Bundle snapshot, you can use `baseline.artifactRef` instead. Choose one source.

### Target

Create `my-experiment/target.yaml`. This example allows the Application to create, modify, or delete only the `SKILL.md` file for each skill under `plugins/terminal-base/skills/` in the Baseline.

```yaml
schemaVersion: rsi.target/v1
id: target.my-terminal-skills
entries:
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

Save the example as `my-experiment/recipe.yaml`, alongside `target.yaml` and `baseline/`.

`policy.wikiskill` learns from training tasks, evaluates the Baseline and any changed candidate on validation tasks, and evaluates the test tasks after the search.

```yaml
schemaVersion: rsi.recipe/v1
id: my-terminal-skills
application:
  ref: application.agentbundle
  config:
    target: { schema: ./target.yaml }
    baseline: { directory: ./baseline }
policy:
  ref: policy.wikiskill
  input:
    candidateRef: ${{ application.initialCandidate }}
  config:
    maxRounds: 1
    dataset:
      trainTaskIds: [terminal-bench/html-js-filter]
      validationTaskIds: [terminal-bench/formal-crypto]
      testTaskIds: [terminal-bench/bun-sourcemap-leak]
bindings:
  evaluator:
    ref: evaluator.agentbench
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

| Field | How to use it |
| --- | --- |
| `schemaVersion`, `id` | Use `rsi.recipe/v1` and a descriptive Recipe ID. Use CLI `--id` to identify a particular run. |
| `application` | Set `ref` to a registered Application ID and use its configuration Schema for `config`. Target and baseline paths here are relative to the Recipe file. |
| `policy` | Set `ref` to a registered Policy ID. Use `config` for Policy parameters and `input` for initial values. |
| `bindings` | Map Policy slots to registered plugin IDs and static configuration. WikiSkill supplies default bindings for Agent, Proposer, Memory, and Selector, so this Recipe only adds the Evaluator. **When the `ref` stays the same, overrides merge by top-level config key.** |
| `budget` | Set experiment limits for call counts and elapsed time. See the fields and defaults below. |
| `reflection` (optional) | For a Policy that declares and explicitly calls Reflection, use `{ configFile: ./reflection.yaml }` to replace the Policy's Reflection configuration file. |

A supported plugin field can use `${NAME}` for an environment reference. That syntax differs from a Runtime expression such as `${{ application.initialCandidate }}`. See the [Recipe loader](../../src/runtime/loaders/index.ts) and the [WikiSkill configuration Schema](../../src/policies/wikiskill/schemas/wikiskill-config.yaml).

### Budget

The Recipe lists all five built-in Runtime budget fields.

| Field | What it limits | When omitted |
| --- | --- | --- |
| `operations` | Operation calls handled by the Runtime, including Application initialization, plugin calls, and nested calls. One Policy iteration can trigger several operations. | No limit for this field |
| `evaluationRuns` | Evaluator runs. A run can cover multiple tasks. This example allows up to four runs for Baseline validation, training evaluation, validation of a changed candidate, and the final test. | No limit for this field |
| `modelCalls` | Model requests that the optimizer and other components make and charge through RSI's Agent backend. The Evaluator tracks requests from the benchmark Solver. | No limit for this field |
| `elapsedWallMs` | Time allowed for experiment execution in milliseconds. On resume, the Runtime calculates the remaining time from the original start time. | `86400000` (24 hours) |
| `cleanupReserveMs` | Time in milliseconds to wait for cleanup such as releasing instances and shutting down plugins. The Runtime calculates a separate cleanup deadline. | `60000` (1 minute) |

The three counters accept nonnegative safe integers. The two time fields accept integers from `1` to `4294967295`. A custom plugin can use `context.charge(metric, amount)` to record its own metric and set a limit under the same key in `budget`. A custom key takes effect when a call charges that metric. See the [Manager's accounting and timeout logic](../../src/runtime/manager/index.ts).

## 3. Validate, run, and inspect

Before running the experiment, prepare Docker, benchmark tasks, images, and model access. Follow the [WikiSkill example](../../examples/harness/dsh-wikiskill/README.md).

Set the following variables in the shell that launches RSI. This example uses Bash. In PowerShell, use `$env:NAME = 'value'` for each variable.

```sh
export MODEL_NAME="your-optimizer-model"
export EVALUATOR_MODEL_NAME="your-solver-model"
export MODEL_ENDPOINT="https://your-model-service.example/v1"
export MODEL_API_KEY="your-api-key"
```

```sh
ember-rsi catalog # List registered IDs
ember-rsi validate my-experiment/recipe.yaml # Check configuration, contracts, and bindings
ember-rsi run my-experiment/recipe.yaml --id terminal-skills-01 # Run the experiment
ember-rsi show terminal-skills-01 # Inspect the saved status and results
```

- Use `ember-rsi list` to find saved experiments.
- Use `ember-rsi cancel terminal-skills-01` to request cancellation.
- To resume an interrupted experiment, add `--resume` to the original command and reuse its Recipe, working directory, and experiment ID.
- Run `ember-rsi serve --port 4317` from the same working directory to inspect saved candidates, measurements, and calls at `http://127.0.0.1:4317`.

## Next steps

- [Understand how a Recipe runs](concepts/architecture.md) and how the Runtime coordinates the Application, Policy, and plugins.
- [Choose a built-in Policy and its components](guides/built-in-components.md) for your optimization target and evaluation setup.
- [Use Skills](guides/using-skills.md) with a coding assistant, the evaluated Agent, or the optimizer.
- [Configure Reflection](guides/reflection.md) to revise guidance during an experiment or apply saved revisions to future experiments.
- [Tune inference service parameters](guides/parameter-search.md) with grid or Optuna search.
- [Write a Policy](guides/writing-policies.md) to change the experiment flow or stopping rules.
- [Write and register a plugin](guides/writing-plugins.md) to supply a new implementation for a Policy slot.
- [Subscribe to or publish Runtime events](guides/runtime-events.md) from an extension.
