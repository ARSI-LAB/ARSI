# DSH GEPA

This example optimizes the Office discipline prompt with GEPA v2. The
[Recipe](recipe.yaml) uses the [baseline Office Bundle](baseline/) and its narrow
[Target](target.yaml). The algorithm source is
[`src/plugins/search-prompt-evolution/`](../../../src/plugins/search-prompt-evolution/) and its orchestration Policy is
[`src/policies/gepa/policy.yaml`](../../../src/policies/gepa/policy.yaml).

## Running

Prepare Node 24, install the project dependencies, and configure the Evaluator's
WorkBuddy Office execution environment. Run the following commands from the
repository root.

Configure `MODEL_ENDPOINT`, `MODEL_API_KEY`, `GEPA_WORKBUDDY_SOURCE` and
`GEPA_WORKBUDDY_CACHE` in the execution environment. The model name is a proxy
alias; inspect its upstream route before running a real evaluation. The example
contains the Office Bundle and its narrow Target; the WorkBuddy dataset remains
an external local source. Point `GEPA_WORKBUDDY_SOURCE` at the complete
`wb-bench-office-v1.0` dataset. The SDK's Office defaults check that the source
contains all 50 tasks before filtering by the requested task IDs.

```sh
pnpm build
pnpm ember-rsi validate examples/harness/dsh-gepa/recipe.yaml
pnpm ember-rsi run examples/harness/dsh-gepa/recipe.yaml --id gepa-office
```

The built-in startup entrypoint provides `search.prompt-evolution` and `policy.gepa`.
Run facts, candidates, measurements and receipts are stored in `.rsi/`.

The plugin is named for its modular prompt-evolution capability. This Policy
uses its existing GEPA sampling, comparison and crossover rules; the shared
`contract.search` also supports the separate Optuna implementation.

The Policy invokes `evaluator` and `proposer` explicitly. The search plugin owns
GEPA's selection, comparison, and population bookkeeping; it does not route
calls to those plugins. Mutation uses `proposer.agent`, which invokes `agent`,
validates edits, and commits through the Application. The Recipe configures the
Evaluator and Agent and keeps algorithm parameters in `bindings.search.config`.
The task split and its Schema belong to the Policy, with the task IDs configured
in `policy.config.dataset`. The search plugin owns its algorithm configuration
Schema. Its public
`contract.search` interface is shared with Optuna. Its `initialize`, `suggest`,
and `observe` lifecycle exchanges immutable state references, evaluation and
proposal work requests, and feedback; GEPA's population, lineage, RNG and
pending-round details stay inside the implementation's state artifacts.

## Algorithm shape

- Initialization samples the selection set and records the initial candidate
  and seeded RNG state. The Policy evaluates that candidate and passes the
  Measurement back to the optimizer to establish its per-instance scores.
- Each Policy loop iteration is one logical attempt. `completedRounds` counts
  only attempts where a proposal was committed as a candidate and evaluated;
  no-change attempts are recorded in `rounds` without inflating that count.
  The configured `maxRounds` bounds both the Policy loop and the plugin's
  round-limit check before a further proposal or evaluation. The Policy
  checkpoints the selected plan and RNG state reference before invoking the
  Evaluator or Proposer.
- Mutation samples a parent from the instance-wise Pareto frontier after
  pruning redundant instance leaders in ascending aggregate-score order,
  weighted by surviving instance-leading frequency. It
  rotates one module cursor, evaluates the parent on the feedback minibatch,
  supplies the current candidate and the sampled Measurement's training
  summary to the Proposer, records a candidate,
  evaluates it on the same minibatch, and admits only a strict mean
  improvement. Admitted candidates are then scored on selection data.
- `crossoverEvery` controls when the System-aware Merge path is attempted.
  Crossover samples candidates from the whole accepted population (not the
  instance-winner sampling pool), checks direct/transitive ancestry, repeated
  merge keys, ancestor aggregate eligibility and module desirability, then
  combines modules by the Appendix D.1 rules. It compares the merged candidate
  with both genetic source parents on the same minibatch and admits a merge
  that matches or exceeds the better parent's mean, as in the official GEPA
  implementation. The Application
  workspace base is the common ancestor, while the optimizer state separately
  records both genetic parents and their inherited lineage.
- Crossover does not advance the mutation module cursor. A fallback mutation
  still advances it exactly once.
- `maxRollouts` bounds task evaluation attempts. Initial selection is truncated
  to the remaining allowance. Before starting a later attempt, the plugin
  reserves its worst-case cost: `2b + n` task rollouts for mutation or `3b + n`
  for crossover, where `b` is the feedback minibatch size and `n` is the fixed
  selection-set size. Task evaluations are accounted once per Measurement;
  receipt replay during checkpoint recovery does not count them again.
  Comparison and selection are distinct Policy calls, so both execute and count
  even when their candidate and task sets match. A measured zero remains a valid
  score and an unavailable/failed/unknown result stays unknown.

Only complete finite selection vectors participate in parent sampling or final
selection. Candidate identities appear once in the population. Both comparison
and selection scoring require matching measurement conditions, task conditions
and scalar metric definitions. An unavailable or incompatible Measurement does
not count as a completed round. Evaluator and Proposer exceptions propagate
through the Policy and stop the run. Cancellation also stops subsequent work.

This RSI adaptation keeps one global mutation-module cursor and schedules
crossover periodically. The reference GEPA implementation keeps a cursor per
candidate and schedules merges after accepted mutations. These orchestration
choices are not intended to reproduce the reference implementation's exact
candidate sequence.

The seeded sampler (mulberry32) and its state are stored in immutable search
artifacts. The Policy checkpoints their references alongside the requested work.
Identical inputs and seed reproduce the random choices; reproducing the complete
candidate sequence also requires identical Agent and Evaluator results, including
the same receipt-replay behavior. A seed does not make live model output
deterministic.

## Office task split

The Recipe uses ten training tasks and five disjoint validation tasks from the
[WorkBuddy Bench Office subset](https://github.com/Tencent/workbuddy-bench#overview).
The ordered task lists live in `policy.config.dataset`: `trainTaskIds` is the
training pool and `validationTaskIds` is the validation pool. The Policy maps
these to the search initialization inputs `feedbackTaskIds` and
`selectionTaskIds`. The search plugin returns the selected task IDs, and the
Policy invokes the Evaluator with those IDs. `paretoSize: 5` keeps all five
validation tasks for candidate selection. There is no independent test set or
test evaluation stage; GEPA does not need an extra `testTaskIds` setting.
`datasetDegenerate` is `false` for this split.

The local Evaluator runs up to five tasks concurrently and prepares up to five
task environments in pipeline mode. A validation evaluation submits the same
five task IDs in one Evaluator call; the one-task feedback minibatch uses one
execution slot. GEPA rounds retain their existing Policy order.

The search allows up to `maxRounds: 10` optimization attempts, with
`maxRollouts: 64` and `minibatchSize: 1`. Each attempt samples one training task;
the rollout allowance can stop the search before ten attempts, and sampling
does not guarantee coverage of all ten training tasks. The Recipe-wide budget
limits only elapsed wall time to `86400000` ms (24 hours).

## Evidence and limits

The Proposer uses `evidenceView: training-summary` to receive
authorized scores, evaluator feedback, and execution excerpts associated with
the sampled tasks. This bounded projection may omit or truncate content and
does not expose the complete archived trajectories as virtual files. Full
execution artifacts remain in Runtime storage for separate inspection. Private
verifier files and hidden grading answers are excluded from the execution
projection. The selected module is enforced by existing Proposer edit
constraints and the Application Target. This candidate mutation is separate
from Runtime Reflection, which revises plugin guidance.
The example opts into the SDK's `includeTaskAnswer` recording option to retain
the public task prompt. The evaluator adapter publishes only that prompt as an
initial execution event; any reference answer remains in private native records.
The Recipe and Policy leave model-call and output-token limits unset. The
Recipe-wide budget limits only elapsed wall time. Evidence uses the existing
Runtime summary limits. The Office target edits
only `plugins/office-base/prompts/office-discipline.md`; model weights and all
other Bundle files are unchanged.
