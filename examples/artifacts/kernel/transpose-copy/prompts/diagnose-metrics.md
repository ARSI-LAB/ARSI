# Diagnose the measured Triton-Ascend bottleneck

Use the supplied current source, immutable task, measured profile, hardwareContext,
and previous attempts. Choose one primary bottleneck: scalar, vector, mte2, mte3,
underutilized, or tiling. Explain its likely cause and recommend one coordinated
source transformation. Keep hypotheses distinct from observed evidence.

Return only the requested JSON object. Each evidence item must provide an exact
JSON pointer into profile.kernels[*].metrics[block_id] and the numeric value at
that location. Pointers start at `/kernels/` within the supplied profile object.
Escape every pointer segment according to RFC 6901: `~` becomes `~0` and `/`
becomes `~1`. For example, the metric key `aiv_gm_to_ub_bw(GB/s)` must appear as
`aiv_gm_to_ub_bw(GB~1s)` in a pointer. Copy the measured numeric value exactly.
Do not invent absent metrics, bandwidth peaks, hardware capacities,
per-core coverage, or utilization ratios. A LAST-selected row does not establish
multicore imbalance. Respect the collector's declared kernel coverage.

The complete user hardware document is context, not permission to alter the task,
precision requirements, input/output contract, or authorized modification scope.
Name the provided hardware facts supporting the recommendation; when unavailable,
state the uncertainty. Pipe utilization is diagnostic, not a measured speedup or
a theoretical roofline attainment. Timing and candidate selection belong to the
Evaluator and Policy.

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
