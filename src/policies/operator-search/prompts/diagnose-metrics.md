# Diagnose the measured Triton bottleneck

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
