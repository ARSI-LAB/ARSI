# Built-in components

English | [简体中文](built-in-components_zh.md) · [Getting started](../getting-started.md)

This guide explains the roles and combinations of built-in Policies and plugins so you can choose components for an experiment.

Use these commands to inspect the available components:

- `ember-rsi catalog`: List registered plugin and Policy IDs.
- `ember-rsi list plugins`: View plugin descriptions, contracts, and input, output, and configuration Schemas.
- `ember-rsi list policies`: View Policy descriptions, Schemas, required contracts, and plugins that satisfy those contracts.

Built-in registrations are defined in the [built-in registry](../../../src/runtime/builtins.ts). Matching contracts indicate compatible interfaces; check whether a plugin's functionality suits your task before selecting it.

## Policy

Choose a built-in Policy for your optimization needs; see its README for configuration and run instructions:

| Policy                                                         | Typical use                                                                                                     | Usage guide                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `policy.harness2` ([paper](https://arxiv.org/abs/2610.14224))  | Try different Agent improvements and select results by final deliverable quality.                               | [README](../../../examples/harness/dsh-harness2/README.md)               |
| `policy.wikiskill` ([paper](https://arxiv.org/abs/2608.27454)) | Improve Agent skills using experience from training tasks.                                                      | [README](../../../examples/harness/dsh-wikiskill/README.md)              |
| `policy.gepa` | Optimize modular prompts through reflective proposals and population search. | [README](../../../examples/harness/dsh-gepa/README.md) |
| `parameter.agent` | Establish a measurable baseline and tune inference-engine parameters with Agent proposals. | [README](../../../examples/artifacts/inference/parameter-agent/README.md) |
| `policy.parameter-grid`                                        | Try predefined parameter combinations one by one to select a better inference service configuration.            | [README](../../../examples/artifacts/inference/parameter-grid/README.md) |
| `policy.parameter-optuna`                                      | Use evaluation feedback to search parameters and improve inference service performance within a limited budget. | [README](../../../examples/artifacts/inference/parameter-tpe/README.md)  |
| `policy.operator-search`                                       | Optimize Triton-Ascend kernels using correctness checks and performance feedback.                               | [README](../../../examples/artifacts/kernel/transpose-copy/README.md)    |

Agent, Grid, and Optuna each evaluate the initial configuration once before search. Supply a configuration that can start the service and reserve one evaluation run for the baseline. A baseline evaluation failure stops the experiment.

`parameter.agent` invokes `evaluator.inferencebench` directly for each candidate, serially. A confirmed, cleaned startup failure records a failed Measurement and rejects that candidate. SDK measurement failures, cancellation, incomplete collection or unconfirmed cleanup stop the experiment. A failed baseline cannot seed the search. With its default `selector.inference`, the Policy can retain an improved candidate before all performance targets are met. Its output keeps the incumbent `candidateRef` and `measurementRef`; `candidateFeasible` reports whether it satisfies the configured constraints, including when `status` is `no-feasible-configuration`.

## Loop components

| Role          | Built-in component                              | Purpose                                                                                                                  | Typical use                                                                             |
| ------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Application   | [`application.agentbundle`](#application)       | Manage Agent Bundle file versions and execution instances.                                                               | Optimize prompts, skills, and Agent code.                                               |
| Application   | [`application.inference`](#application)         | Manage inference configuration versions and service instances.                                                           | Tune batching, concurrency, and other service parameters.                               |
| Application   | [`application.kernel`](#application)            | Manage Triton-Ascend source versions and evaluation workspaces.                                                          | Optimize NPU kernel code.                                                               |
| Proposer      | `proposer.agent`                                | Use a model to edit files based on optimization goals and execution evidence.                                            | Improve prompts, skills, or code.                                                       |
| Proposer      | `proposer.operator`                             | Generate, repair, and summarize kernel changes using source analysis, evaluation, or profiling results.                  | Improve kernel implementations iteratively.                                             |
| Proposer      | `proposer.grid`                                 | Generate parameter combinations from predefined values.                                                                  | Search a small parameter space with a finite set of choices.                            |
| Proposer      | `proposer.optuna`                               | Propose parameter combinations through Optuna and receive evaluation feedback.                                           | Tune parameters iteratively within a limited budget.                                    |
| Proposer | `proposer.pareto-evolution` | Evolve prompt modules through reflective proposals, Pareto sampling, and ancestry-aware crossover. | Optimize prompts using feedback and selection tasks. |
| Evaluator     | `evaluator.agentbench`                          | Run Agent benchmark tasks and save scores and execution evidence.                                                        | Assess changes to prompts, skills, or code.                                             |
| Evaluator     | `evaluator.inferencebench`                      | Benchmark inference services and measure throughput, latency, and other metrics.                                         | Compare the performance of service configurations.                                      |
| Evaluator     | `evaluator.operatorbench`                       | Use the Evaluator SDK to check correctness, measure latency, and optionally collect profiling data.                      | Check whether kernel changes are correct and faster.                                    |
| Selector      | `selector.metric`                               | Compare candidates using specified metrics and constraints.                                                              | Select a better version by success rate, throughput, latency, or other numeric results. |
| Selector      | `selector.inference`                            | Improve constraint violations before optimizing the primary metric within the targets.                                   | Tune inference performance while retaining useful progress toward latency targets.      |
| Selector      | `selector.artifact`                             | Use a model to review anonymously presented reports or other deliverables against a rubric.                              | Select candidates by content quality.                                                   |
| Agent backend | [`agent.pi`](configuration.md#pi-backend)       | Run proposal generation, content review, experience consolidation, and similar tasks through Pi.                         | Drive optimization with a model service of your choice.                                 |
| Agent backend | [`agent.codex`](configuration.md#codex-backend) | Run proposal generation, content review, experience consolidation, and similar tasks through a local Codex installation. | Reuse an existing Codex login and configuration.                                        |

`selector.inference` uses the same `contract.selector-metrics` interface and configuration fields as `selector.metric`. While constraints remain unmet, it accepts a candidate if no constraint violation increases and at least one decreases. Equal violations require improvement in the primary metric beyond the configured threshold. A satisfied constraint must remain satisfied; once all constraints are met, selection optimizes the primary metric without returning to an infeasible candidate. Configured `eligibility` checks remain hard requirements. Only complete, comparable measurements with the required metrics can be selected.

## Application

An Application initializes candidate versions, validates and commits changes, and acquires and releases instances for evaluation. `application.agentbundle` manages Agent Bundles; `application.inference` manages inference service configurations and instances; `application.kernel` manages Triton-Ascend source code and evaluation workspaces. The kernel baseline's `input.py` must define `kernel_function`. See the [operator optimization example](../../../examples/artifacts/kernel/transpose-copy/README.md) for setup and configuration.

### Change scope (Target)

This section configures **which files optimization may change, which operations are allowed, and the limits on file size and each commit**. The built-in `application.agentbundle`, `application.inference`, and `application.kernel` store these rules in a Target file.

Set `application.config.target.schema` in the Recipe to select the rules file:

```yaml
# Recipe excerpt
application:
  plugin: application.agentbundle
  config:
    target: { schema: ./target.yaml }
    baseline: { directory: ./baseline }
```

Here, `baseline` is the initial file directory, and `target.yaml` defines the permitted changes. For definitions and preparation instructions, see [Baseline](../getting-started.md#baseline) and [Target](../getting-started.md#target) in Getting started.

| What to limit                  | Target field                                                 | How to fill it                                                                                       |
| ------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Which files may change         | `entries[].path`, `entries[].kind`, `entries[].include`      | Specify a file or directory and the patterns within a directory, such as matching only `*/SKILL.md`. |
| Which operations are allowed   | `entries[].changes`                                          | Choose allowed operations from `create`, `modify`, and `delete`.                                     |
| Which files must be protected  | `protected`                                                  | List files or path patterns that must not change, such as `bundle.yaml` and `agent.yaml`.            |
| How large each file may be     | `entries[].content.maxBytes`                                 | Set the file-size limit in bytes.                                                                    |
| How much one commit may change | `constraints.maxChangedFiles`, `constraints.maxChangedBytes` | Limit the number of changed files and their total content size in bytes, respectively.               |

Before committing a new candidate, the Application checks the actual file changes. It rejects a commit that changes files outside the permitted scope, uses an unauthorized operation, or exceeds a configured limit. These size and file-count limits are optional; the Target imposes no corresponding limit when they are omitted. See the [file change checks](../../../src/plugins/shared/file-application/target.ts) for the rules.

## Self-improvement components

### Memory

Memory requires explicit integration in the Policy. The Policy calls `memory.agent` to turn evidence and observations into reusable experience, saves the returned `memoryRef`, and passes it to later steps that use the experience. For example:

- **WikiSkill**: After each round's training evaluation, update the experience using its scores and execution evidence, then pass it to that round's Proposer to help improve skills.
- **Harness²**: After each task, use execution traces to update the experience, then pass it to Proposers in later tasks.

The Policy can continue if an update fails. See the [Memory guide](memory.md) for details.

### Reflection

Reflection requires an explicit execution step in the Policy. Specify the guidance files and other resources that may change in the Reflection configuration file, then declare a `type: reflection` step in the Policy to call `reflection.agent` and propose changes based on execution evidence. For example:

- **Harness²**: Authorizes changes to the Invariant Proposer and Domain Proposer's `guidance` files. Its `improve_guidance` step is commented out by default; enabling it in a custom Policy allows these files to be updated for later Proposer calls to use when generating proposals.

Runtime activates validated changes within the current experiment for later plugin calls to read and use. Follow the [Reflection guide](reflection.md) for configuration, resource authorization, and reuse across experiments.


### Inference configuration candidates

Remote inference reads one JSON candidate from `remote.parametersFile` (default
`tuning.json`). `parameter.agent` edits only `config.parameterFile`; the launcher
remains fixed. The Policy accepts a configurable `goal` and `selection` description
for the proposer. Nested options and environment settings can be interpreted by
the launcher without uploading engine source or build scripts.

The framework reserves service endpoint options (`host`, `port`,
`served_model_name`, `data_parallel_rpc_port`); other engine choices are validated
by the launcher and engine. Memory utilization is tunable unless startup
calibration owns it. Quality, precision and context preservation remain prompt
requirements, not an automated accuracy guarantee.

Metric constraints support `exclusiveMax: true` for a strict upper bound.
`selector.inference` can accept reduced constraint violations before feasibility,
without worsening another violation. Once feasible, `minRelativeImprovement`
controls primary-metric gains. Metric names, bounds and optimization direction
belong to Recipe configuration, not hardcoded selector goals. Failed candidates
can be rejected without fabricated scores; unknown or cancelled outcomes remain
errors. Training-summary proposers receive public metric values and units in
`context/metrics.json`, independently of bounded evidence previews.
