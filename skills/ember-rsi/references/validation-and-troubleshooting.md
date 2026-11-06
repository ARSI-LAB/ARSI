# Verification and troubleshooting

For a new installation, use [quickstart](quickstart.md) in an isolated workspace using the supplied package. For an existing experiment, inspect its records first; diagnosis alone does not require launching another run. The included `run.mjs` checks execution, candidate lineage, measurements, lease release and non-replaying successful resume. For a changed Policy also exercise zero rounds, no-change and branch outputs. For real models/hardware report environmental prerequisites and actual requests separately.

| Symptom                                           | Correction                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Cannot resolve ember-rsi                          | Install the supplied package in the extension's ancestor workspace; cwd alone does not affect ESM lookup                  |
| Unknown Policy/plugin                             | Pass --plugin-dir to the executing CLI/server, or register in the same embedded Runtime                                   |
| Definition rejected                               | `contract` is an imported contract object; Policy require uses the contract ID string                                     |
| Delivery rejected for unauthorized paths          | Diff the delivered files against the declared entries; keep helper types in the plugin and report a shared-contract change as out of scope |
| Target fields missing                             | Start from bundled target.yaml; id, entries, kind, description and changes are required                                   |
| bundle.yaml invalid                               | Copy the entire baseline including nonempty plugins, entry, lockfile and plugin metadata                                  |
| Invalid Policy input passed validate              | Final input_schema validation occurs during Manager.run; assert its rejection, then inspect a persisted record if present |
| Materialize rejects destination                   | Use a new or empty real directory, not an existing populated output or symlink                                            |
| Binding agent.default/agent undeclared            | Declare the binding in the owning Policy require even when an editor invokes it indirectly                                |
| validate passes, run fails                        | Validation is not Application initialization or provider readiness                                                        |
| recordCandidate rejects input                     | Call scoped context method with `(artifactRef, parentRef)`, not an object; use Application commit for proposals           |
| editRef rejected                                  | Pass workspace.ref from a workspace created with the correct parent candidate                                             |
| Measurement rejected                              | Use complete typed records, valid referenced artifacts and current experiment/call ownership                              |
| Selector refuses comparison                       | Match definitions and nonempty comparisonKey; successful/complete coverage required                                       |
| Unavailable score behaves like zero               | Keep unavailable/failed/unknown results out of selection and admission pools; require a successful measurement before comparing |
| Every round reports the same proposal             | The repeated call identity returns the earlier receipt; include the round or attempt in the identity and report executed work rather than replays |
| Reflection sees only scores and summaries         | Pass the sampled execution context (task input, observable Agent output, rollout trajectory) into the reflective request, bound to the correct task/module, and mark unavailable evidence explicitly instead of omitting it |
| Reflective session ends after tool reads          | A session cap counts response turns, not files: several tool calls may share one turn, but the final structured response needs its own. Size the cap as the inspection turns the request requires plus the final response plus headroom, consolidate the evidence into few reads, then rerun a workload that performs multiple reads before answering |
| Reflected module repeats after a crossover        | Advance the module-rotation cursor only when a mutation selects a module; a crossover selects none, so it must not skip one |
| Task-rollout allowance exceeded                   | The rollout allowance counts instances, not runs; check the remainder before each batched selection, parent/proposal or crossover rollout and leave framework evaluation-run units unchanged |
| Crossover offered to a source's own descendant    | Persist both genetic parents and the mixed candidate's inherited ancestry; the Application workspace base is not the parent |
| Merge admitted below both parents                 | Compare the merge with both genetic parents on the same comparison instances rather than with their common ancestor or construction base |
| Missing candidateRef input                        | Add Policy mapping from application.initialCandidate                                                                      |
| Expression rejected                               | Expressions occupy the entire scalar; initialize state and use lexical `steps.<id>.output` references                     |
| Unsafe configuration pointer                      | Reflection resources are field names such as guidance, not /guidance or file paths                                        |
| Reflection skipped                                | Need at least three eligible completed calls, authorized evidence and explicit type: reflection                           |
| Memory not used                                   | Carry memoryRef through state into a later proposer call                                                                  |
| Budget exhausted                                  | Include baseline, nested Agent/Reflection calls and original elapsed time                                                 |
| Resume blocks uncertain effects                   | Inspect receipt and external resource state; do not edit facts or blindly retry                                            |
| HTTP cancellation response but no terminal result | Inspect the owner and persisted state; terminal cancellation has a known rejection risk in this version                   |

Claims require distinct evidence: configuration valid (host validation), execution succeeded (terminal record/output), cleanup complete (release/resource records), improved (comparable measurements), online evolution (write/load/delivery/actual later use). A score of zero is not an execution failure. Unknown usage is not zero.

Repository `pnpm check` combines formatting, types, unit tests and build; `pnpm check:package` verifies independent consumption. Neither substitutes for real-model or hardware acceptance. Keep probes under `.scratch/`, `.rsi/` or a temporary directory; do not add credentials or historical run output to the skill.

## Self-test the path you will execute

A green local suite proves only the branches it covers. Derive the invariants from the requirement text — configured limits, per-strategy eligibility, ordering of effects, no-change and rejection outcomes, value semantics and cleanup — and give each one a deterministic check at the public boundary.

- Prefer the composed public path: real registry, real Agent/tool interface, and the same limits and session caps the Recipe declares. A unit-level stub does not show that a bounded loop can finish.
- Treat nested sessions as their own request budgets. A reflective or delegated Agent needs enough requests for file inspection, delegation and the final structured response; when a session cap is hit, the child ends without its result and the parent reports missing output rather than a provider error. See [model budgeting](advanced.md#budgeting-real-editing-calls).
- Budget by turns rather than by files: several tool calls may share one response, but each response-and-result turn and the final structured response spend requests. Run one controlled workload that reads the prompt plus several execution files and then answers, so the declared cap is exercised against the evidence the request really carries.
- Prove a whole round, not just a session: through the real Agent/tool interface assert that a structured proposal was returned, committed as a candidate and evaluated, and that every session's turn count stayed within its own cap. A session that stops after its reads, or a Policy that only validated, is not a completed round.
- Exercise counterexamples, not only the happy path: the limit minus one and the limit itself, a rejected transition on the final round, an eligible parent that wins no individual comparison, and a no-change result.
- Cover score semantics explicitly: an unavailable initial/baseline score, a failed or unknown-coverage execution, and a measured zero. Assert that selection and admission consume only valid observed scores and that unavailable results keep their own meaning.
- Cover repeated rounds with distinct scripted responses through the ordinary Manager/Agent/Evaluator interfaces. Assert that each logical round executes once, that genuine reuse of one identity stays reuse, and that reported rounds and rollouts count executed work.
- Cover each counted budget in the unit it declares: rounds, evaluation runs and per-instance task rollouts are different allowances. Assert that initial selection scoring and batched parent/proposal/selection or crossover evaluation spend one allowance per instance and start nothing beyond the remaining amount.
- Exercise an admitted crossover followed by a later crossover decision through public state. Assert that the mixed candidate records both source parents and that neither source nor any transitive ancestor/descendant is offered as a partner. Also assert that admission compares the merge with both genetic parents on the same comparison instances, including a case where the shared construction ancestor scores much lower than both parents.
- Cover module rotation across strategy transitions: with two editable modules, assert the reflected modules are `a`, `b`, `a` across mutation, mutation, crossover, mutation, including both admitted and rejected crossovers, and that the crossover leaves nonselected module contents unchanged.
- Cover reflective inputs: script authorized execution evidence carrying distinct task-input and Agent-output markers, then assert that both reach the reflective request bound to the correct task and module, that an unavailable execution record stays explicitly unavailable, and that any example the meta-prompt describes is present in what was actually delivered.
- Resolve test fixture paths from the test module, workspace or a temporary directory instead of an assumed working directory, so the suite passes from any runner root and on both path conventions.
- Assert absence of effects after termination: no proposal, rollout or evaluation starts once the configured limit is consumed.
- State which invariants each test covers. An unexercised requirement stays an explicit evidence gap rather than an implied pass.

## Bounded recovery

Recover within the user's agreed time, request and cost limits. A new experiment ID does not reset consumed budget. Retry only when evidence identifies a changed condition; distinguish permission recovery from model requests and code changes.

1. Preserve the error, experiment ID, call receipt, usage and owned-resource state. Establish whether a request/effect was sent, completed, or remains unknown before replaying it.
2. Choose a correction from evidence below. State the changed condition and the check that will establish recovery. Change one failing boundary where practical.
3. Resume only with unchanged resources/configuration and a supported safe checkpoint; otherwise start an explicitly linked new attempt. Query results without replaying completed work.
4. Stop when the agreed budget is exhausted, the same cause recurs without new evidence, cleanup is unconfirmed, or the necessary contract/environment is unavailable. Report the smallest missing input and retain the last valid candidate. A useful blocked diagnosis is not a completed experiment.

| Failure class                                   | Next action                                                                                                                         | Do not do                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Invalid field, binding, contract or metric      | Read the relevant public Schema/metric definition; fix that field and validate in the executing host                                | Guess a sequence of parameter names or read package internals                |
| Local sandbox permission denied before dispatch | Use the execution environment's permission mechanism; retain the original version                                                   | Treat permission denial as provider outage or change model parameters        |
| Connection refused or unavailable service       | Confirm the authorized endpoint and service readiness; retry only after a changed condition                                         | Restart unrelated services or count an unsent request as completed inference |
| Provider rejects an optional parameter          | Remove the unsupported option or use the configured supported backend; preserve the response                                        | Cycle through provider-specific flags without a documented contract          |
| Empty/malformed model output or output limit    | Inspect finish reason and usage; simplify the response or adjust output budget within the agreed total                              | Assume all empty content is a transient network error                        |
| Uncertain write, cleanup or external execution  | Reconcile receipts and external state through the owning component; follow [CLI recovery](cli.md#resume-without-corrupting-history) | Blindly retry, delete locks or rewrite facts                                 |

Prefer the configured `agent.pi` for the provided editing workflows. Build a custom Agent only when the task needs a capability it cannot supply; custom HTTP code also owns provider compatibility, cancellation, structured-output parsing and request accounting. Use read-only observation around the existing backend when the purpose is tracing, rather than replacing it merely to inspect inputs.
