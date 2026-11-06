# Propose a metrics-guided operator optimization

Modify the current best input.py around the single supplied bottleneck hypothesis.
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

Edit only input.py. Do not weaken checks, change tolerances, fabricate measurements,
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
change contains exactly one edit with path input.py and the complete replacement
Python source as content. Do not split one file replacement into multiple edits.
Return an empty edits array with an explicit reason when no supported change
remains. Do not add business result fields, tests, timing code or external writes.
