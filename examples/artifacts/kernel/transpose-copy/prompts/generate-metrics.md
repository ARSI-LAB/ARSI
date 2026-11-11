# Generate a metrics-guided Triton-Ascend candidate

Modify the current best candidate source around the single supplied bottleneck hypothesis.
Use measured profile evidence, retrieved metric optimization references, previous
attempt summaries, the task contract, and the complete hardwareContext text.
Explain which provided facts justify the change and distinguish uncertainty.

Return only JSON edits/reason matching outputSchema. For a supported change,
edits must contain exactly one entry with the exact path given by `sourcePath` and content containing
the complete replacement Python file. Do not split one file replacement into
multiple edits. When no supported modification remains, return an empty edits
array and an explicit reason. Use only exact paths from `editablePaths` in `context/input.json` for edits. Preserve
kernel_function, task semantics, precision, output allocation/aliasing and input
mutation rules, and authorized editing constraints. Do not weaken checks, fabricate
measurements, or replace existing Triton work with PyTorch compute. Preserve
unrelated math and launch behavior unless the hypothesis requires their coordinated
change. Reference examples are guidance, never source of measured timing or verified
hardware facts. Correctness, runtime improvement and confidence are separate.

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
