---
name: ember-rsi
description: Use when asked to optimize or iteratively improve a measurable target with ember-rsi, including inference engines on local or remote machines, agent harnesses, skill discovery and invocation efficiency, project AGENTS.md instructions, prompts, or tunable configurations. Supports defining objectives, correctness gates and budgets; researching relevant industry work and papers; discovering installed plugins and Policies with their contracts and Schemas; composing and running Recipes; inspecting progress, measurements and failures; implementing missing compatible plugins; and comparing candidates against a baseline. Also use for requests to improve a project from conversation or commit evidence, or prepare recurring optimization through an available host scheduler. Assumes the local ember-rsi CLI is installed.
---

# RSI — make everything rsi-able

Turn an optimization requirement into a bounded, measured experiment. Prefer an existing Recipe, then configuration/binding changes, then a Policy composed from existing operations, then an implementation of an existing contract.

## Start here

Assume the local `ember-rsi` CLI is installed. Discover current capabilities with `ember-rsi --help`, `ember-rsi list plugins`, and `ember-rsi list policies`. These commands expose descriptions, contracts and input/output/config Schemas. For older installations inspect `ember-rsi catalog` and identify gaps before adapting. Normal use does not require a source checkout. Source development uses Node 24.x and pnpm 11.22.0.

## Harness + skills + CLI workflow

1. **Clarify the requirement:** target machine/project, allowed edits, representative workloads, correctness constraints, success metric, baseline, execution environment, budget and rollback. Ask only for consequential missing inputs.
2. **Research existing work:** search current industry implementations and primary research relevant to the bottleneck. Record source links and testable hypotheses. Existing campaign evidence may guide continued work; research alone does not prove improvement.
3. **Discover and reuse:** inspect `ember-rsi list plugins` and `ember-rsi list policies`. Match Schemas, required contracts and default bindings. `compatiblePolicies` lists contract-compatible binding slots, not proven suitability. Prefer existing components, then configuration/bindings, then new orchestration.
4. **Implement concrete gaps:** follow [plugins](references/plugins.md) using an existing public contract when possible. Put compiled extensions in `~/.ember-rsi/plugins/<name>/index.mjs` exporting `register(registry)`; additional directories use `--plugin-dir`. See [extension loading](references/external-plugins.md). Keep schemas in `schema.ts`, business logic/lifecycles in `service.ts`, and assembly in `index.ts`. Prepare a separate repeatable doctor check with working and broken prerequisites; installed doctor coverage requires RSI to bundle that check.
5. **Preflight, run and observe:** assemble a `rsi.recipe/v1` Recipe and compare its effective configuration (Policy defaults plus binding overrides) with the user's objective, workload, baseline and constraints. Explain any mismatch by naming the goal, field and consequence; for example, raw P99 latency with selector `direction: maximize` favors higher latency. Run `ember-rsi doctor <recipe.yaml>` in the intended execution environment with the same `--plugin-dir` options and surface failed and unchecked findings. Doctor's JSON and exit code depend only on scripted checks, not conversational goals. SDK-backed Evaluators delegate to the full SDK doctor, which can download probe resources, acquire images and run Docker build probes; use its findings to prepare remaining prerequisites. Then measure a baseline and run a bounded experiment. `run` remains independent of doctor and can start directly. Use `ember-rsi show <id>`, `ember-rsi list` and `ember-rsi dashboard` to inspect progress, measurements and failures. Keep the execution process alive; CLI runs do not detach.
6. **Deliver evidence:** compare the best correct candidate with the baseline under comparable conditions. Include regressions, usage, reproduction and rollback instructions. Report no improvement when measurements do not support one.

## Example request routing

- **Optimize an inference engine on a machine:** establish access, hardware, engine version and workloads; measure throughput/latency under correctness and memory constraints. Follow [inference experiments](references/inference-experiments.md). A local surrogate does not establish remote hardware gains.
- **Optimize local skills for efficient invocation:** inventory discovery metadata and overlap, construct representative routing/task cases, measure selection accuracy and task success alongside tool calls, tokens and latency. Evaluate isolated candidate copies before activation and preserve user content.
- **Optimize project AGENTS.md from daily work:** use authorized project conversations and commits as evidence, derive representative task cases, keep a held-out regression set and preserve mandatory project rules. Evaluate an isolated copy and deliver a reviewable diff with measurements. Missing conversation access is an explicit evidence gap.
- **Optimize daily at midnight:** establish timezone, evidence access, budgets, overlap handling and whether changes are proposed or applied. Use an available host scheduler with an explicit project working directory and one bounded experiment per day. RSI has no built-in scheduling command. Confirm scheduler creation before reporting a schedule as active.

For inspection or diagnosis, use the relevant reference without creating an experiment. For a new installation or uncertain wiring, use the credential-free [quickstart](references/quickstart.md). Reuse established campaign resources. Run doctor in the executing host and distinguish schema validity, prerequisite readiness, actual execution, cleanup and measured improvement.

| Task                                             | Reference                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Ownership, facts, lifecycle                      | [Core concepts](references/core-concepts.md)                                           |
| Recipe, Target, baseline, model settings         | [Recipes](references/recipes.md)                                                       |
| Terminal commands and recovery                   | [CLI](references/cli.md)                                                               |
| Web observation and control API                  | [Web](references/web.md)                                                               |
| Algorithm, typed steps, loops and state          | [Policies](references/policies.md)                                                     |
| Custom plugin and public service calls           | [Plugins](references/plugins.md), [service signatures](references/runtime-services.md) |
| Startup registration                             | [External extensions](references/external-plugins.md)                                  |
| Embedding and candidate handoff                  | [Programmatic integration](references/programmatic.md)                                 |
| Model, Memory, current Reflection                | [Advanced capabilities](references/advanced.md)                                        |
| Stock SDK benchmarks and evaluator configuration | [SDK evaluators](references/sdk-evaluators.md)                                         |
| Inference/hardware campaigns                     | [Inference experiments](references/inference-experiments.md)                           |
| Errors and evidence standards                    | [Troubleshooting](references/validation-and-troubleshooting.md)                        |

## Preserve ownership

Use only `rsi.recipe/v1` and `rsi.policy/v1`. Register plugins and Policies explicitly in the executing host. A Recipe `ref` does not import code. Contract objects own input/output Schemas; implementations own configuration and `execute`/`dispose`. Applications own targets and instances; Evaluators measure instances; Manager services own facts, budgets and leases; Policies orchestrate.

Keep generated state in `.rsi/`. Preserve resource origins and credentials as environment references. Do not mutate Manager facts to force recovery. Real model/hardware execution needs the user's task authorization and an explicit budget. This skill does not authorize commits, publication or production deployment.

## Deliver evidence

Report tested package revision, commands, resulting experiment ID, selected candidate/measurement, usage, cleanup and unresolved limits. Distinguish schema validity, startup acceptance, successful execution and measured improvement. The starter's text-predicate score verifies wiring only; it is not benchmark quality or model improvement. Online evolution requires later execution within the same unfinished task, with evidence of writing, loading, delivery and actual use.
