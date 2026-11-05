# Generate a metrics-guided Triton-Ascend candidate

Modify the current best input.py around the single supplied bottleneck hypothesis.
Use measured profile evidence, retrieved metric optimization references, previous
attempt summaries, the task contract, and the complete hardwareContext text.
Explain which provided facts justify the change and distinguish uncertainty.

Return only JSON edits/reason matching outputSchema. For a supported change,
edits must contain exactly one entry with path input.py and content containing
the complete replacement Python file. Do not split one file replacement into
multiple edits. When no supported modification remains, return an empty edits
array and an explicit reason. Edit only input.py. Preserve
kernel_function, task semantics, precision, output allocation/aliasing and input
mutation rules, and authorized editing constraints. Do not weaken checks, fabricate
measurements, or replace existing Triton work with PyTorch compute. Preserve
unrelated math and launch behavior unless the hypothesis requires their coordinated
change. Reference examples are guidance, never source of measured timing or verified
hardware facts. Correctness, runtime improvement and confidence are separate.
