# From requirements to experiments

Use this workflow for new optimization campaigns and follow-up stages. Reviewing a skill does not authorize executing its example campaign.

## Translate the request

Extract the target, baseline, allowed edits, execution environment, correctness gate, final metrics, workload, resource limits and stopping conditions. Separate hard requirements from goals whose feasibility must be measured. Ask only for consequential missing information unavailable from authorized inspection.

Create a task-owned campaign manifest under `.rsi/` with stage IDs, Recipe/resource locations, code/dependency revisions, baseline and parent candidate references, metric definitions, correctness criteria and budgets. This is runtime experiment state, not a requirement to add repository design/task documents. Keep credentials out of shared files and logs.

## Discover before extending

Inspect CLI catalog and the skill's complete Recipes/Targets/baselines and public service guide. For an external benchmark, require its supplied supported configuration and environment information; report missing integration contracts rather than guessing them. Build a small capability map: requirement, existing component, exact required contract, configuration needed, verified support and gap.

For each gap, first try configuration or compatible bindings. If orchestration alone is missing, compose a small Policy using existing operations. If execution capability is missing, implement an existing contract. Only introduce a contract when existing ones cannot express the needed inputs/results. State why cheaper reuse paths fail before writing new code; retain framework accounting and lifecycle ownership rather than creating a parallel experiment runner.

Current registered Policies include Harness², WikiSkill and vLLM autotune. They have different contracts and learning assumptions. An agent proposer is not interchangeable with a grid proposer. A goal string does not add profiling, Memory, correctness validation or code-editing tools to a Policy.

## Run bounded stages

Establish a measured, correct baseline before search. Use small stages for feasibility, baseline/profile, a specific bottleneck, combination/regression checks and final end-to-end acceptance. Set explicit per-stage rounds, evaluation/model/operation budgets, elapsed bounds and cleanup reserve; include baseline and failed evaluations in estimates.

Before each attempt read historical evidence and write the bottleneck, hypothesis, proposed change and expected effect. Prefer one interpretable change or a justified coupled set. Record candidate lineage, change, profile, correctness, performance, environment, usage and conclusion. After failure, classify infrastructure, correctness, capacity, noise or hypothesis failure; refine within a bounded budget. Revisit a failed approach only with a stated changed condition or new evidence.

Across stages explicitly materialize the selected candidate as the next baseline with its provenance and Target scope. Do not assume unrelated experiments share incumbent state. Preserve the best correct implementation and its comparable measurement, even when the latest attempt fails. Keep final acceptance workloads separate from learning feedback when the chosen algorithm requires it.

Memory only helps if the Policy calls it and delivers its content to subsequent proposals. Reflection needs its configFile module and an explicit use: reflection call; structural acceptance does not prove improvement. Verify writing, loading, delivery and actual later use before claiming online evolution. An outer agent may read persisted experience between stages without claiming the inner Policy performs Memory/Reflection.

## Stop and deliver

Stop when required targets are verified, major evidenced bottlenecks are handled with small remaining end-to-end benefit, justified candidates repeatedly fail to improve within the declared budget, or execution conditions block progress. Define the practical benefit/noise threshold and retry budget from baseline measurements; do not silently substitute budget exhaustion for target attainment.

Deliver runnable Recipes/host/extensions, the best correct candidate, complete attempt records, reproduction and resume/rollback instructions, baseline/final measurements and unresolved blockers. Distinguish validated configuration, actual execution, cleanup, correctness and achieved improvement. Offline trace analysis during resource blockage may improve the optimizer, but does not establish a new hardware performance result.
