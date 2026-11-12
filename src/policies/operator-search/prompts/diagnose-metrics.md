# Diagnose a measured operator bottleneck

Use the supplied current source, immutable task, measured profile, hardwareContext
and previous attempts. Identify one primary bottleneck and a source-level
hypothesis that could address it. Infer the backend from actual supplied context;
do not assume a particular vendor, memory system or compiler.

Use one category from the current analysis protocol:

- `scalar`: measured scalar work warrants investigation.
- `vector`: measured vector work warrants investigation.
- `mte2` or `mte3`: use only when the supplied backend documentation and profile
  identify that transfer pipeline. Do not rename another architecture's memory
  metrics to these categories by assumption.
- `underutilized`: observed metrics support insufficient use of the available
  execution resources.
- `tiling`: measured behavior and source structure support investigating work
  granularity, locality or reuse.

Separate recorded observations from explanations and uncertain causes. Respect
metric units and the collector's declared kernel, iteration and core coverage.
A selected kernel row does not establish multicore imbalance. Missing capacities,
peak bandwidth, utilization denominators and pipeline evidence remain unknown;
do not fill them from templates or unrelated devices.

Every evidence item must point to an observed numeric field under
profile.kernels[*].metrics[block_id]. Use an RFC 6901 JSON pointer starting with
`/kernels/`, escaping `~` as `~0` and `/` as `~1` in every segment. Copy the numeric
value exactly. Do not use unavailable hardware-derived fields or invent values
to satisfy the output Schema.

If authorized network tools are available to the bound Agent, official profiling
or compiler documentation can clarify a field or supported mechanism. Otherwise
use the supplied and retrieved context and preserve uncertainty. Online material
cannot replace measured evidence or alter the task and modification scope.

## Use history without turning uncertainty into a ban

Program-owned `facts` and `measurementRefs` record formal Evaluator results. Each
lesson, avoid pattern and try pattern has `text` and `basis`:

- `evaluation`: an observation backed by this attempt's formal measurements.
- `agent-report`: an Agent's account of local probes or other unverified observations.
- `hypothesis`: a static inference or an untested explanation or next experiment.

Only formal results establish measured candidate outcomes. Agent reports and
hypotheses remain advisory. Do not turn a failed concrete candidate into a ban on
an entire technique, require proven speedup before proposing, or accumulate
prerequisites that block every next experiment. Avoid repeating the same measured
losing transformation unless a changed assumption or mechanism makes the new
experiment distinct; explain that difference.

## Decide whether there is a new testable hypothesis

A busy pipe or repeated profile does not by itself imply a new source edit.
Consider the previous attempts before recommending a transformation. A plausible
untested mechanism is sufficient; a measured gain is not required. If a previous
transformation lost, propose a materially different test or explain which changed
assumption justifies revisiting it. Uncertainty alone does not exhaust search.

Return exactly one of these JSON shapes, matching outputSchema:

- A hypothesis: `{"status":"hypothesis","category":"...","summary":"...",`
  `"reasoning":"...","rootCause":"...","recommendedFix":"...","evidence":[...]}`.
  Use the existing categories and exact observed metric pointers described above.
- No new hypothesis: `{"status":"no-new-hypothesis","reason":"..."}`.
  Explain why no distinct bounded transformation can currently be justified and
  which missing evidence would help. Do not invent a fix merely to fill the Schema.

No new hypothesis stops this search with the incumbent retained. It is a statement
about the supplied evidence and scope, not proof that the operator is optimal.
