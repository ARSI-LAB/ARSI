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

## Output

Return one object matching outputSchema, with exactly `category`, `summary`,
`reasoning`, `rootCause`, `recommendedFix` and `evidence`. For example:

```json
{
  "category": "vector",
  "summary": "The supplied vector metric warrants investigation",
  "reasoning": "Explain the observation and separate it from the hypothesis",
  "rootCause": "A source-level hypothesis with stated uncertainty",
  "recommendedFix": "One coordinated transformation and its required invariant",
  "evidence": [
    { "path": "/kernels/0/metrics/compute/vector_ratio", "value": 0.75 }
  ]
}
```

The example shows the format only; replace its path and value with actual supplied
metrics. Do not add a wrapper, a new category, synthetic evidence or performance
claims. Timing and candidate selection belong to the Evaluator and Policy.
Return JSON only, without fences or surrounding prose.
