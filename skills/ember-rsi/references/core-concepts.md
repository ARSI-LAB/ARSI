# Runtime ownership

| Component   | Responsibility                                                                           |
| ----------- | ---------------------------------------------------------------------------------------- |
| Registry    | Explicit contracts, operations and Policy registrations                                  |
| Runtime     | Assembly: context, registry, manager, dispose                                            |
| Manager     | Controlled calls, immutable candidate/measurement facts, budgets, checkpoints and leases |
| Application | Target and baseline validation, edit commit, instance acquire/release                    |
| Policy      | Pure orchestration, branching, loops and persistent state                                |
| Recipe      | Concrete Application, Policy, bindings, resources and budgets                            |

A Candidate identifies immutable content (`artifactRef`) and parent lineage. An Instance leases execution resources for that Candidate. A Measurement identifies candidate, evaluation conditions, metric definitions/values and evidence; existence of a candidate does not mean it has been evaluated. Keep selected candidate and measurement together.

Memory is a business operation whose returned `memoryRef` must be passed into subsequent calls. Reflection proposes resource revisions; Runtime controls structural acceptance and activation. Neither implies quality gain without comparable evaluation.

The current flow is: author files → load/register extensions → validate Recipe → await `manager.run` or poll an accepted HTTP job → inspect result, facts and cleanup → dispose the owning host. There are no saved-Recipe CRUD, preview tokens, pause/continue or `runs.start` APIs.

Default data lives under `.rsi/facts/` and `.rsi/artifacts/`, with workspaces/checkpoints and plugin-owned state under the same root. Resources can be read from their original paths during execution, so do not modify them during a run or before a resume. An embedding host can choose a separate `directory`; CLI uses cwd/.rsi.

Failures, cancellation and unknown effects are different from a valid evaluation with score zero. Query stored evidence rather than re-running to inspect results. The starter illustrates baseline → child → measurements → selection → release with no model or external evaluator.
