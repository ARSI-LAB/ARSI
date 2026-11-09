# ![ember-rsi](docs/users/assets/ember-rsi-logo.png)

### Multiple self-improvement strategies in one framework · Make Everything RSI-able.

Generate candidates, evaluate their performance, and iterate in one framework, from agent harnesses to AI infrastructure.

![Node.js 24.x](https://img.shields.io/badge/Node.js-24.x-339933?logo=nodedotjs&logoColor=white)![pnpm 11.22.0](https://img.shields.io/badge/pnpm-11.22.0-F69220?logo=pnpm&logoColor=white)![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue)

English | [中文](./README.zh-CN.md)

[Overview](#overview) · [How it works](#architecture) · [Everything is a plugin](#extensions) · [Installation](#installation) · [Using ember-rsi](#usage) · [Built-in RSI strategies](#built-in-rsi-strategies) · [User guides](#user-guide)

<a id="overview"></a>

## ℹ️ Overview

`ember-rsi` is a pluggable framework for recursive self-improvement experiments on agents and AI infrastructure.

- **Recipe-driven self-improvement.** A declarative Recipe (`recipe.yaml`) connects an optimization target (Application), a strategy (Policy), and an Evaluator. Each experiment runs within explicit edit boundaries and a fixed budget.
- **Built-in strategies and extensions.** Run built-in strategies for agent harness optimization and inference parameter search. You can bring other targets into the same framework by defining allowed changes, generating candidates, and measuring their performance.
- **For developers and coding agents.** Developers can configure and run experiments from the CLI and inspect the results in the web viewer. Coding agents can use the same tools through the RSI Skill. Our goal is for them to plan, validate, run, and diagnose experiments, then choose the next step based on evaluation results within the scope and budget a developer authorizes.

<a id="architecture"></a>

## 🔄 How it works

### Architecture Overview

![Architecture animation showing Recipe selecting an Application that manages candidates and evaluation instances](docs/users/assets/rsi-architecture-handdrawn.gif)

1. **Define the optimization target.** Select an Application in the Recipe and configure the baseline and allowed edits. The Application also defines how to turn a candidate into an instance for the Evaluator.
2. **Run the optimization loop.** The Runtime follows the Policy. The Application initializes the baseline, validates and commits edits from the Proposer, and provides and releases instances for the Evaluator. The Selector uses evaluation results or deliverables to choose the next starting point.
3. **Improve the components.** A Policy can use Memory to retain experience and Reflection to improve component prompts, resources, or configuration from execution evidence.

<a id="extensions"></a>

### Everything is a plugin

![Animation of a Harness² Policy call resolving its Agent binding, invoking Pi, and invoking Codex after a Recipe change](docs/users/assets/rsi-plugin-mechanism.gif)

*Harness² example · The Proposer references the `agent` binding. Changing that binding in the Recipe routes the same call from `agent.pi` to `agent.codex` on the next run.*

- **Application** is the core plugin selected under `application` in the Recipe. It defines what to optimize, what may change, and how to prepare and release candidate instances for evaluation. Built-in Applications manage Agent Bundles, inference service configurations, and Triton-Ascend kernels.
- **Policy** defines the RSI loop, stopping conditions, and the contract each plugin binding requires.
- **Plugin** implements a contract. The contract specifies the inputs and outputs, and implementations that satisfy it can be swapped.
- **Recipe** selects the Application and Policy, binds the plugins used by the flow, and supplies configuration and budgets.

- [Choose an Application](docs/users/guides/built-in-components.md#application)
- [Write a Policy](docs/users/guides/writing-policies.md)
- [Write a plugin](docs/users/guides/writing-plugins.md)
- [Assemble an experiment with a Recipe](docs/users/guides/configuration.md#recipe-fields-and-binding-overrides)

<a id="installation"></a>

## 📦 Installation and deployment



### Agent Instruction

Copy this instruction into your coding agent:

```text
Install the ember-rsi CLI and companion skill from https://github.com/evolving-foundry/ember-rsi.
Follow the README's manual CLI installation instructions: check prerequisites, clone the repository, install dependencies, build, and install the CLI.
Copy the complete skills/ember-rsi directory, including references and templates, into a skill directory supported by this agent. Ask before replacing an existing skill with the same name.
Run ember-rsi --help and confirm that this agent can discover and read the skill. Complete installation only; do not start experiments or make model calls.
```



### Manual Installation



#### 1. Install the CLI

Requirements

1. **Node.js** >= 24.19.0 and < 25.
2. **pnpm** 11.22.0.
3. **Git**, required to fetch the AgentBundle and Evaluator SDK dependencies.

```sh
# Clone and build ember-rsi.
git clone git@github.com:evolving-foundry/ember-rsi.git
cd ember-rsi
pnpm install --frozen-lockfile
pnpm build
pnpm add -g .

# Verify that the built CLI is available.
ember-rsi --help
```



#### 2. Install the skill

Run this from your target project and select the coding agent to install to:

```sh
npx skills add evolving-foundry/ember-rsi --skill ember-rsi
```

Add `-g` for a user-wide installation. Reload or restart your agent as required, then confirm that it can discover and read the `ember-rsi` skill.

Load the RSI Skill in a coding agent and provide the optimization goal, permitted edits, and budget. The agent can choose or write a Recipe, validate the configuration, and, once authorized, run the experiment, inspect results, and diagnose failures.

- The [RSI Skill entrypoint](skills/ember-rsi/SKILL.md) uses the reference material and templates in the full `skills/ember-rsi/` directory. Use the [minimal example](skills/ember-rsi/references/quickstart.md) to check that the Recipe and plugins work together.

<a id="usage"></a>

## 🛠️ Using ember-rsi



### Quick start



#### 1. Configure models and the evaluation environment

This walkthrough uses the WorkBuddy Office scenario from the [Harness² example](examples/harness/dsh-harness2/README.md). Follow the [Evaluator's WorkBuddy setup guide](https://github.com/evolving-foundry/ember-evaluator/blob/master/docs/users/benchmarks/workbuddy.md) to prepare Docker, the dataset, and container images. Make sure both the host and the evaluation containers can reach the model endpoint.

```bash
# Set these variables in the terminal where you run ember-rsi. ember-rsi does not load .env files automatically.

# Optimizer model used to propose candidate changes.
export MODEL_NAME="your-optimizer-model"

# Model used by the evaluated agent. There is no fixed default.
# Set this to a model supported by your endpoint.
export EVALUATOR_MODEL_NAME="your-evaluation-model"

# Endpoint and API key shared by both models by default.
export MODEL_ENDPOINT="https://your-model-service.example/v1"
export MODEL_API_KEY="your-api-key"
```



#### 2. Validate, run, and resume an experiment

The Harness² example optimizes an AgentBundle baseline across 10 tasks, with up to 40 evaluations and a 72-hour time budget. For a first run, keep just the first task in `policy.config.dataset.taskIds` in `[recipe.yaml](examples/harness/dsh-harness2/recipe.yaml)`.

```sh
# Validate the Recipe without starting the experiment.
ember-rsi validate examples/harness/dsh-harness2/recipe.yaml

# Start the experiment with this ID. This makes real model calls.
ember-rsi run examples/harness/dsh-harness2/recipe.yaml --id my-harness2-task
```

- Candidates, evaluation metrics, call receipts, and evidence are stored in `.rsi/` in the current directory by default. Review the evaluation status, scores, and deliverables together.
- For details, see the [getting started guide](docs/users/getting-started.md), [Reflection guide](docs/users/guides/reflection.md), and [runtime events guide](docs/users/guides/runtime-events.md).

Resume an interrupted experiment from the original working directory using the same Recipe and experiment ID.

```sh
# Resume from the saved checkpoint.
ember-rsi run examples/harness/dsh-harness2/recipe.yaml --id my-harness2-task --resume
```



### Check experiment progress

Run both commands from the same directory where you ran `ember-rsi run`. They read experiment data from that directory's `.rsi/` folder.

To check an experiment's status in the terminal, pass its ID to `show`.

```sh
ember-rsi show my-harness2-task
```

To view progress in the browser, start the local read-only dashboard and open the address printed in the terminal.

```sh
ember-rsi dashboard
```

<a id="built-in-rsi-strategies"></a>

## Built-in RSI strategies


| Policy                    | How it improves the target                                                                          | Example Recipe                                                                             | Replaceable plugins                                                                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy.harness2`         | Evaluates general, domain-specific, and combined edits, then compares deliverables anonymously.     | [DSH Harness²](examples/harness/dsh-harness2/README.md)                                    | [`agent.pi`](src/plugins/agent-pi), [`proposer.agent`](src/plugins/proposer-agent), [`evaluator.agentbench`](src/plugins/evaluator-agentbench), [`selector.artifact`](src/plugins/selector-artifacts), [`memory.agent`](src/plugins/memory-agent) |
| `policy.wikiskill`        | Builds a wiki from training runs and independently tests skill edits that improve on validation.    | [DSH WikiSkill](examples/harness/dsh-wikiskill/README.md)                                  | [`agent.pi`](src/plugins/agent-pi), [`proposer.agent`](src/plugins/proposer-agent), [`memory.agent`](src/plugins/memory-agent), [`evaluator.agentbench`](src/plugins/evaluator-agentbench), [`selector.metric`](src/plugins/selector-metrics)     |
| `policy.parameter-grid`   | Searches a parameter grid for the highest throughput within constraints such as latency SLOs.       | [Inference grid search](examples/artifacts/inference/parameter-grid/README.md)             | [`proposer.grid`](src/plugins/proposer-grid), [`evaluator.inferencebench`](src/plugins/evaluator-inferencebench), [`selector.metric`](src/plugins/selector-metrics)                                                                               |
| `policy.parameter-optuna` | Searches inference parameters with Optuna TPE or random sampling.                                   | [Inference TPE search](examples/artifacts/inference/parameter-tpe/README.md)               | [`proposer.optuna`](src/plugins/proposer-optuna), [`evaluator.inferencebench`](src/plugins/evaluator-inferencebench), [`selector.metric`](src/plugins/selector-metrics)                                                                           |
| `policy.operator-search`  | Searches for Triton-Ascend operator improvements and independently rechecks the selected candidate. | [Transpose-copy operator optimization](examples/artifacts/kernel/transpose-copy/README.md) | [`agent.pi`](src/plugins/agent-pi), [`proposer.operator`](src/plugins/proposer-operator), [`evaluator.operatorbench`](src/plugins/evaluator-operatorbench), [`selector.metric`](src/plugins/selector-metrics)                                   |

<a id="user-guide"></a>

## 📖 User guides

- [Getting started](docs/users/getting-started.md)
- [Architecture and core concepts](docs/users/concepts/architecture.md)
- [Built-in components](docs/users/guides/built-in-components.md)
- [Configure an experiment](docs/users/guides/configuration.md)
- [Run and inspect experiments](docs/users/guides/running-experiments.md)
- [Use skills](docs/users/guides/using-skills.md)
- [Memory guide](docs/users/guides/memory.md)
- [Reflection guide](docs/users/guides/reflection.md)
- [Write a Policy](docs/users/guides/writing-policies.md)
- [Write a plugin](docs/users/guides/writing-plugins.md)
- [Runtime events guide](docs/users/guides/runtime-events.md)



## 🙏 Acknowledgments

Thanks to the Cordis maintainers and contributors. ember-rsi uses Cordis to register plugins, isolate experiment contexts, and dispatch runtime events. [Cordis project](https://github.com/cordiverse/cordis)

## 🔗 Related Projects

- [Ember RSI](https://github.com/evolving-foundry/ember-rsi): Tools for iterative optimization through measured experiments.
- [AgentBundle](https://github.com/evolving-foundry/agentbundle): A unified CLI and SDK for validating, installing, and managing agent bundles across runtimes.
