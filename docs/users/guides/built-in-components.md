# Built-in components

English | [简体中文](built-in-components_zh.md) · [Getting started](../getting-started.md)

Use `ember-rsi catalog` to inspect the registrations in your build. A Recipe binds a Policy slot to a plugin implementation. The Policy declares the contract that the implementation must satisfy. See the [built-in registry](../../../src/runtime/builtins.ts) for the list and the [public contracts](../../../src/contracts/plugin-types/index.ts) for call schemas.

`ember-rsi list plugins` and `ember-rsi list policies` expose descriptions, input/output/config Schemas, contracts and compatible bindings. Compatibility means contract matching, not task suitability. Bare `ember-rsi list` still lists experiments; `ember-rsi catalog` retains compact ID lists.

## Loop components

| Role | Built-in IDs | What they do |
| --- | --- | --- |
| Application | `application.agentbundle`, `application.inference` | Initialize and commit candidates within a Target. Acquire and release a Bundle instance or a remote inference service. |
| Proposer | `proposer.agent`, `proposer.grid`, `proposer.optuna` | Propose model-driven file edits, enumerate a parameter grid, or request parameter trials from Optuna. |
| Evaluator | `evaluator.agentbench`, `evaluator.inferencebench` | Measure Agent or inference candidates through the Evaluator SDK. A saved measurement carries status, coverage, metrics, and evidence references. |
| Selector | `selector.metric`, `selector.artifact` | Compare complete, compatible measurements using metrics and optional constraints, or compare anonymous deliverables with an Agent. |
| Agent backend | `agent.pi`, `agent.codex` | Execute model-backed requests from Proposer, artifact Selector, Memory, and Reflection. Their configuration Schemas and runtime prerequisites differ. |

Pick a built-in Policy according to what you want to optimize and how you can evaluate it.

| Policy | Typical use |
| --- | --- |
| [`policy.harness2`](../../../examples/harness/dsh-harness2/README.md) | Run base, invariant, domain, and composed probes per task and select a deliverable. `k` controls exploration slots per probe and `concurrency` bounds concurrent Policy branches. The flow schedules four evaluator calls per slot per task when it completes all probes. |
| [`policy.wikiskill`](../../../examples/harness/dsh-wikiskill/README.md) | Improve Bundle skills from training evidence, accept changes by validation score, and report final held-out test results. |
| [`policy.parameter-grid`](../../../examples/artifacts/inference/parameter-grid/README.md) | Enumerate a finite parameter space and select a feasible service configuration by measured performance. |
| [`policy.parameter-optuna`](../../../examples/artifacts/inference/parameter-tpe/README.md) | Adapt parameter trials from measurement feedback within a configured budget. |

The Agent binding configures the optimizer and other Agent-backed components. The Evaluator's service config independently configures the benchmark solver. See the [Pi configuration Schema](../../../src/plugins/agent-pi/schema.ts) and the [Codex configuration Schema](../../../src/plugins/agent-codex/schema.ts).

## Self-improvement components

### Memory

`memory.agent` consolidates authorized evidence and observations into a reusable experience artifact. The Policy stores the returned `memoryRef` and passes it into later steps that support it. WikiSkill uses `training-summary` for learning and separates training, validation, and held-out reporting. Harness² uses `execution` and controls its Memory step with `policy.config.memory`.

### Reflection

`reflection.agent` proposes revisions to resources declared in a Reflection configuration. A Policy invokes the module at an explicit serial `use: reflection` step. The built-in Harness² Policy declares a Reflection configuration and leaves its `improve_guidance` step commented out. Add an explicit call in your Policy to run it. Runtime validates, persists, and activates accepted revisions in the experiment. A later call must load and use the revised resource for it to affect that call. Follow the [Reflection guide](reflection.md) to configure evidence, authorized resources, and reuse across runs.
