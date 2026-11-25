# From requirements to experiments

Use this workflow for new optimization campaigns and follow-up stages. Reviewing a skill does not authorize executing its example campaign.

## Translate the request

Extract the target, baseline, allowed edits, execution environment, correctness gate, final metrics, workload, resource limits and stopping conditions. Separate hard requirements from goals whose feasibility must be measured. Ask only for consequential missing information unavailable from authorized inspection.

Create a task-owned campaign manifest under `.rsi/` with stage IDs, Recipe/resource locations, code/dependency revisions, baseline and parent candidate references, metric definitions, correctness criteria and budgets. This is runtime experiment state, not a requirement to add repository design/task documents. Keep credentials out of shared files and logs.

## Discover before extending

Inspect CLI catalog and the skill's complete Recipes/Targets/baselines and public service guide. For SDK-backed benchmarks, first read the matching configuration shipped with the installed Evaluator and adapt it through the existing RSI adapter; see [SDK configuration reuse](sdk-evaluators.md#start-from-the-installed-evaluator-configuration). Use prior experiments as evidence for their benchmark conditions, and verify which host settings apply to this execution environment. Build a small capability map: requirement, existing component, exact required contract, configuration needed, verified support and gap.

For each gap, first try configuration or compatible bindings. If orchestration alone is missing, compose a small Policy using existing operations. If execution capability is missing, implement an existing contract. Only introduce a contract when existing ones cannot express the needed inputs/results. State why cheaper reuse paths fail before writing new code; retain framework accounting and lifecycle ownership rather than creating a parallel experiment runner.

Current registered Policies include Harness², WikiSkill and vLLM autotune. They have different contracts and learning assumptions. An agent proposer is not interchangeable with a grid proposer. A goal string does not add profiling, Memory, correctness validation or code-editing tools to a Policy.

## Validate the written configuration

Before sizing concurrency or launching preparation, check the written Recipe and its referenced resources:

- Compare effective Policy defaults and binding overrides with the requested objective, baseline, editable scope, metric direction, task IDs/splits, rounds and budgets. Name the field and consequence of any mismatch; maximizing raw latency, for example, rewards slower candidates.
- Load the Recipe with the intended plugin registrations using [`Recipe.load`](programmatic.md), then inspect the resolved local inputs. Run component diagnostics during [execution-host preparation](#diagnose-and-prepare-on-the-execution-host).
- For SDK-backed evaluation, validate the equivalent native configuration with the installed SDK's public loader or documented validation command. Include the actual solver/application inputs, environment references and network settings. The RSI adapter's broad schema is not proof that nested SDK configuration is valid. Do not pass an RSI Recipe directly to the Evaluator CLI.

Fix configuration errors before proceeding. Record what was actually checked; static validation does not establish data authorization, usable model routes or Docker readiness.

## Analyze concurrency before selecting values

Read the chosen Policy's effective configuration and execution flow, and the installed SDK's scheduler/preparation limits. Determine execution and preparation concurrency separately:

| Limit                         | Evidence to inspect                                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks in one evaluation call  | Training minibatch, validation/test batch and per-call task selection. A scheduler limit above the batch size cannot add work.                                                                                                              |
| Simultaneous evaluation calls | Policy branches, exploration slots and nested calls. Account for their combined load rather than sizing each call against the entire host.                                                                                                  |
| Execution capacity            | SDK/solver caps, CPU, RAM, accelerator memory, container requirements, model-service rate limits and other active work on the execution host.                                                                                               |
| Preparation capacity          | Native preparation worker limit, image/build/download concurrency, cache sharing, disk capacity and temporary storage. Set this separately from solver concurrency, accounting for shared resources when preparation and execution overlap. |

For example, a four-task validation call with scheduler concurrency 16 still runs at most four tasks; two such calls can demand eight execution slots. Optimization rounds do not determine parallelism. Do not increase batches, rounds or budgets just to fill workers.

Report each applicable upper bound and its source, the proposed execution and preparation values, and aggregate peak demand. Distinguish a configured or theoretical maximum from a capacity demonstrated on the host. If a limiting resource is unknown, mark it unverified and propose a bounded capacity check instead of claiming a safe maximum. Honor the user's concurrency constraints within those limits. Revalidate any configuration changed after the initial checks.

## Diagnose and prepare on the execution host

Run `arsi doctor recipe.yaml` with the final settings on the intended host when environment preparation is authorized. Use the same plugin directories, launching-process credentials, network settings, Docker context and cache as the planned run. SDK-backed evaluators delegate native diagnostics to the installed SDK; avoid duplicating its download or image preparation logic.

Report the command, host, configuration identity, exit code, passed/failed/unchecked counts and actionable findings. Exit code 0 can include unchecked results. If full doctor was not run, state why and which readiness questions remain unanswered. Configuration-only requests or unavailable execution hosts can still produce validated materials and a useful readiness report; do not invent a host prerequisite to replace a missing check.

Address observed failures within scope, then rerun the affected checks. Full doctor may fetch probe assets and build temporary images; it does not establish a completed warmup or scored run. When native warmup is available and authorized, prepare the exact task selection through the SDK, preserve its ready/failed counts and exit status, and reuse matching valid caches. Run model-route inference probes within the authorized preparation scope and budget. Keep model requests, data access, image preparation and scored execution as separate evidence.

## Review the prepared experiment with the user

Complete the authorized configuration, analysis and checks before asking for the launch decision. Present a reviewable summary containing:

- The Recipe/resources and versions, reused Evaluator configuration and intentional overrides, baseline, task split, model request route, rounds and budgets.
- Execution and preparation concurrency, supported upper bounds, aggregate demand and any capacity not yet verified.
- Validation, doctor and warmup results or explicit reasons they were not run; unresolved failures, unchecked items and their impact on the next step.
- The proposed next command or action and its scope: additional preparation, a bounded diagnostic run, or baseline and optimization execution.

For a new or materially changed configuration, ask the user to confirm that configuration and next step before starting scored baseline/optimization work or dispatching it to an external executor. A request to prepare Recipes alone does not authorize launching them. If the user has already approved the same configuration and execution scope, cite that approval and continue without asking again; raise only consequential changes or missing decisions. Keep real blockers explicit rather than treating confirmation as evidence that a prerequisite passed.

The CLI `run` command remains independent of doctor. This review is the skill's preparation workflow, not a new Runtime gate.

## Run bounded stages

After the readiness review and execution authorization, establish a measured, correct baseline before search. Use small stages for feasibility, baseline/profile, a specific bottleneck, combination/regression checks and final end-to-end acceptance. Set explicit per-stage rounds, evaluation/model/operation budgets, elapsed bounds and cleanup reserve; include baseline and failed evaluations in estimates.

Before each attempt read historical evidence and write the bottleneck, hypothesis, proposed change and expected effect. Prefer one interpretable change or a justified coupled set. Record candidate lineage, change, profile, correctness, performance, environment, usage and conclusion. After failure, classify infrastructure, correctness, capacity, noise or hypothesis failure; refine within a bounded budget. Revisit a failed approach only with a stated changed condition or new evidence.

Across stages explicitly materialize the selected candidate as the next baseline with its provenance and Target scope. Do not assume unrelated experiments share incumbent state. Preserve the best correct implementation and its comparable measurement, even when the latest attempt fails. Keep final acceptance workloads separate from learning feedback when the chosen algorithm requires it.

Configure a serial trigger and evidence window for each runtime evolution module. Check that subsequent authorized calls received the active Memory or plugin revision. Verify writing, loading, delivery and actual later use before claiming online evolution. An outer agent may read persisted experience between stages without claiming the inner Policy performs Memory/Reflection.

## Stop and deliver

Stop when required targets are verified, major evidenced bottlenecks are handled with small remaining end-to-end benefit, justified candidates repeatedly fail to improve within the declared budget, or execution conditions block progress. Define the practical benefit/noise threshold and retry budget from baseline measurements; do not silently substitute budget exhaustion for target attainment.

Deliver runnable Recipes/host/extensions, the best correct candidate, complete attempt records, reproduction and resume/rollback instructions, baseline/final measurements and unresolved blockers. Distinguish validated configuration, actual execution, cleanup, correctness and achieved improvement. Offline trace analysis during resource blockage may improve the optimizer, but does not establish a new hardware performance result.

After reporting a successful run, ask whether to release the experiment's resources. Pulling or rebuilding images may slow the next experiment of the same type. Use the original workspace and `--plugin-dir` options for a requested preview (`arsi cleanup <experiment-id> --dry-run`) or an approved cleanup (`arsi cleanup <experiment-id>`).
