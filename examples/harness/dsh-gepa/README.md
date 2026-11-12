# DSH GEPA

This example optimizes the Office discipline prompt with GEPA v2. The
[Recipe](recipe.yaml) uses the [baseline Office Bundle](baseline/) and its narrow
[Target](target.yaml). The algorithm source is
[`src/plugins/proposer-pareto-evolution/`](../../../src/plugins/proposer-pareto-evolution/) and its orchestration Policy is
[`src/policies/gepa/policy.yaml`](../../../src/policies/gepa/policy.yaml).

## Running

Prepare Node 24.19 or newer within the Node 24 release line, install the project
dependencies, and configure the Evaluator's WorkBuddy Office execution
environment. The pinned Evaluator SDK requires Node >=24.19.0. Run the following
commands from the repository root.

Configure `MODEL_ENDPOINT`, `MODEL_API_KEY`, `GEPA_WORKBUDDY_SOURCE` and
`GEPA_WORKBUDDY_CACHE` in the execution environment. The model name is a proxy
alias; inspect its upstream route before running a real evaluation. The example
contains the Office Bundle and its narrow Target; the WorkBuddy dataset remains
an external local source. Point `GEPA_WORKBUDDY_SOURCE` at the complete
`wb-bench-office-v1.0` dataset. The SDK's Office defaults check that the source
contains all 50 tasks before filtering by the requested task IDs.

Set `EVALUATOR_NETWORK_CONFIG` to the absolute path of the included
[`network.yaml`](network.yaml). This selects the pinned SDK's portable network
defaults without loading an unrelated machine-wide configuration. For a network
that requires proxies or mirrors, copy this file to a local location and configure
it using the pinned SDK's supported fields; keep credentials out of this example.
The SDK rejects unknown fields, including the obsolete top-level `version` field.

For POSIX shells:

```sh
export EVALUATOR_NETWORK_CONFIG="$PWD/examples/harness/dsh-gepa/network.yaml"
```

For PowerShell:

```powershell
$env:EVALUATOR_NETWORK_CONFIG = (Resolve-Path examples/harness/dsh-gepa/network.yaml).Path
```

Then build, validate and run the Recipe:

```sh
pnpm build
pnpm ember-rsi doctor examples/harness/dsh-gepa/recipe.yaml
pnpm ember-rsi run examples/harness/dsh-gepa/recipe.yaml --id gepa-office
```

The built-in startup entrypoint provides `proposer.pareto-evolution` and `policy.gepa`.
Run facts, candidates, measurements and receipts are stored in `.rsi/`.

The plugin is named for its modular prompt-evolution capability. This Policy
uses its existing GEPA sampling, comparison and crossover rules; the shared
`contract.proposer-iterative` also supports the separate Optuna implementation.

The Policy invokes `evaluator` and `proposer` explicitly. The search plugin owns
GEPA's selection, comparison, and population bookkeeping; it does not route
calls to those plugins. Mutation uses `proposer.agent`, which invokes `agent`,
validates edits, and commits through the Application. The Recipe configures the
Evaluator and Agent and keeps algorithm parameters in `bindings.evolutionProposer.config`.
The task split and its Schema belong to the Policy, with the task IDs configured
in `policy.config.dataset`. The search plugin owns its algorithm configuration
Schema. Its public
`contract.proposer-iterative` interface is shared with Optuna. Its `initialize`, `suggest`,
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

The search allows up to `maxRounds: 15` logical optimization attempts, with
`maxRollouts: 120`, `minibatchSize: 1`, `feedbackSampling: coverage-first`, and
`crossoverEvery: 0`. Crossover is disabled and is not recommended for this
single-module Office configuration. Every attempt evaluates a training parent
before proposing a mutation.
Coverage-first sampling prioritizes tasks without a finite parent score in a
completed attempt; zero counts as covered, while unavailable scores do not.
Completed no-change attempts count toward coverage when their parent was scored.
With valid parent feedback, coverage-first sampling covers all ten training
tasks in the first ten completed attempts before repeating any. The configured
normal path requires at most 110 task rollouts: five baseline validation tasks
and fifteen mutation attempts at up to seven rollouts each. This is a
configuration-derived upper bound, not measured usage. Failures or the wall-time
limit can still prevent completion. The Recipe-wide budget
limits only elapsed wall time to `86400000` ms (24 hours).

The optional `feedbackSampling` setting defaults to `random`. Coverage-first mode
uses completed round reports and the existing seeded RNG. Checkpoint recovery
preserves selected tasks and completed evaluation receipts.

## Evidence and limits

The Proposer uses `evidenceView: training-summary` to receive
authorized scores, evaluator feedback, and execution excerpts associated with
the sampled tasks. This bounded projection may omit or truncate content and
does not expose the complete archived trajectories in the Agent project. The
Proposer prepares a managed workspace with candidate files under `candidate/`,
the training summary in `context/measurements.json`, and edit constraints and
target metadata in `context/input.json`. The Agent receives `cwd`, `goal`, and
`outputSchema`; final edit paths are relative to `candidate/` without that prefix.
Full execution artifacts remain in Runtime storage for separate inspection. Private
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
