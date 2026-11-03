# Verification and troubleshooting

For a new installation, use [quickstart](quickstart.md) in an isolated workspace using the supplied package. For an existing experiment, inspect its records first; diagnosis alone does not require launching another run. The included `run.mjs` checks execution, candidate lineage, measurements, lease release and non-replaying successful resume. For a changed Policy also exercise zero rounds, no-change and branch outputs. For real models/hardware report environmental prerequisites and actual requests separately.

| Symptom                                           | Correction                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Cannot resolve ember-rsi                          | Install the supplied package in the extension's ancestor workspace; cwd alone does not affect ESM lookup                  |
| Unknown Policy/plugin                             | Pass --plugin-dir to the executing CLI/server, or register in the same embedded Runtime                                   |
| Definition rejected                               | `contract` is an imported contract object; Policy require uses the contract ID string                                     |
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
| Missing candidateRef input                        | Add Policy mapping from application.initialCandidate                                                                      |
| Expression rejected                               | Expressions occupy the entire scalar; initialize state and use proper phase frames                                        |
| Unsafe configuration pointer                      | Reflection resources are field names such as guidance, not /guidance or file paths                                        |
| Reflection skipped                                | Need at least three eligible completed calls, authorized evidence and explicit use: reflection                            |
| Memory not used                                   | Carry memoryRef through state into a later proposer call                                                                  |
| Budget exhausted                                  | Include baseline, nested Agent/Reflection calls and original elapsed time                                                 |
| Resume blocks uncertain effects                   | Inspect receipt and external resource state; do not edit facts or blindly retry                                           |
| HTTP cancellation response but no terminal result | Inspect the owner and persisted state; terminal cancellation has a known rejection risk in this version                   |

Claims require distinct evidence: configuration valid (host validation), execution succeeded (terminal record/output), cleanup complete (release/resource records), improved (comparable measurements), online evolution (write/load/delivery/actual later use). A score of zero is not an execution failure. Unknown usage is not zero.

Repository `pnpm check` combines formatting, types, unit tests and build; `pnpm check:package` verifies independent consumption. Neither substitutes for real-model or hardware acceptance. Keep probes under `.scratch/`, `.rsi/` or a temporary directory; do not add credentials or historical run output to the skill.

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
