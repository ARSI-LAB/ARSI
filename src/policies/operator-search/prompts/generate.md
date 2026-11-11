<!--
Copyright (c) Meta Platforms, Inc. and affiliates.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

-->

# Propose one operator optimization

Improve the supplied operator while preserving its complete task contract. Infer
the backend, implementation language and available APIs from the current source
and explicit environment. Do not choose a vendor, compiler option, execution
model or hardware capacity from an unrelated example.

Start from the stage-entry source. Use the static diagnosis, retrieved guidance
and verified history to choose one supported hypothesis. Match it to the operator
structure: elementwise work, reduction, data movement, matrix computation or a
combination. Consider work partitioning, redundant computation, memory traffic,
locality and reuse where the source supports them. After a verified no-gain
attempt, choose a different supported transformation.

Preserve the public kernel_function signature, output count, shapes, dtypes,
device, layout/strides, aliasing, input mutation rules and allocation ownership.
Retain required wrapper operations and runtime initialization. Preserve effective
precision, intermediate rounding, reduction order and synchronization unless the
authorized task explicitly allows their alteration. Track all consumers when
removing an intermediate. Prove that a hoisted expression is loop invariant.

Keep the change small enough to attribute its effect. Preserve unrelated math,
indexing, launch configuration and compiler options. A coordinated change is
appropriate when the hypothesis requires it; explain that dependency. Check
bounds, masks, tail coverage and that every valid output is written on a fresh
call. Each tuning configuration must independently cover its assigned outputs.
Do not cache results across calls or depend on prior warmups or tuning trials.

Use only APIs and launch options supported by the selected environment. Supply
each launch parameter once, and derive launch geometry from the chosen tiling.
Retrieved implementations are references, not replacements for the public caller
or task contract. Do not replace the operator with reference-library computation,
weaken tests, change tolerances or manufacture timing results. This static stage
has no measured profile unless one is explicitly supplied.

If the bound Agent provides authorized network tools, consult official sources
for unclear API or version support. Otherwise use supplied materials and explain
remaining uncertainty. A reference benchmark is not this candidate's measurement;
only the Evaluator can establish correctness and runtime results.

## Output

Return exactly the JSON edit object required by outputSchema:

```json
{
  "edits": [
    {
      "path": "<one exact path from editablePaths in context/input.json>",
      "content": "The complete valid Python source, JSON-escaped"
    }
  ],
  "reason": "One supported hypothesis, concrete changes and the invariants to verify"
}
```

For a supported change, return one complete replacement per changed file from editablePaths. Keep the
preserved kernel_function entry point. Do not edit task or comparison files, add
tests or timing code, perform external writes, or emit placeholders. When no
supported change remains, return an empty edits array and an explicit reason.
Return JSON only, without fences or surrounding prose; do not claim an improvement
before a real evaluation exists.

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
