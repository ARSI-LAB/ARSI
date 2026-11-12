# Propose a metrics-guided operator optimization

Modify the current best candidate source around the single supplied bottleneck hypothesis.
Use measured profile evidence, retrieved references, previous attempt summaries,
the task contract and the complete hardwareContext. Infer the implementation
language, backend and supported mechanisms from this context. Match changes to
the operator's actual computation and data movement.

Explain which observed facts justify the hypothesis and what remains uncertain.
Preserve the public kernel_function signature, task semantics, precision and
intermediate rounding, indexing, layout, output allocation/aliasing, input
mutation rules and required runtime initialization. Preserve unrelated behavior;
coordinate math, tiling or launch changes only when the hypothesis requires it.
Check bounds, masks, full output coverage and fresh-call correctness.

Use only exact paths from `editablePaths` in `context/input.json` for edits. Do not weaken checks, change tolerances, fabricate measurements,
reuse cached outputs or replace the operator with reference-library computation.
Use compiler options and APIs supported by the supplied environment, without
hardware constants or vendor-specific assumptions copied from unrelated examples.

If the bound Agent provides authorized network tools, official API and hardware
documentation may clarify a supported optimization. Otherwise use supplied
materials and state uncertainty. References do not establish measured timing or
verified hardware facts. Correctness, observed improvement and confidence remain
separate until evaluation.

## Output

Return only JSON with `edits` and `reason`, matching outputSchema. A supported
change contains one edit per changed file from `editablePaths`, with its complete replacement
Python source as content.
Return an empty edits array with an explicit reason when no supported change
remains. Do not add business result fields, tests, timing code or external writes.

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

## Submit an experiment, not a preselected winner

A candidate needs a concrete, plausible mechanism and a contract-preserving edit;
it does not need a demonstrated speedup. State the hypothesis and what formal
evaluation would falsify. Uncertainty about performance alone is not a reason
for empty edits. Do not run timing sweeps or use ad hoc local timings to decide
which candidate the Policy should see. Evaluator measures candidates and Selector
decides promotion. Cheap static checks of bounds and coverage are appropriate.

If the recommended implementation violates an invariant, correct the implementation
while preserving the hypothesis when possible. Return empty edits only when no
reasonable, distinct, testable edit can be formed within the authorized scope;
explain the concrete obstacle. Do not claim that this proves global optimality.
