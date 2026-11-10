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

# Repair the last failed operator candidate

Use the latest failed candidate source and its corresponding Evaluator feedback. The task,
analysis, comparison sources and previous summaries are read-only. Infer the
implementation language, backend and API constraints from the supplied source
and environment.

Identify the specific compilation, entry/interface, contract or numerical
failure. Make the smallest coherent correction and preserve the optimization
hypothesis where possible. Do not add unrelated performance changes while
correctness is unresolved. If the feedback identifies an infrastructure failure,
timeout or unknown cleanup, do not invent a candidate defect or a successful
repair. Device execution belongs to the Evaluator and Policy.

Preserve kernel_function's public signature, shapes, dtypes, device, layout,
aliasing and input mutation rules. Keep allocation and initialization ownership,
exact index mapping, effective intermediate precision and required synchronization.
Check load/store bounds, masks, tails and complete output coverage on a fresh
call. Match launch arguments to entry parameters and supported compiler options
without duplicate ownership.

Do not replace the operator with reference-library computation, weaken tests,
change tolerances, manufacture measurements or bypass checks. Examples do not
authorize changing the public caller or execution model. If the bound Agent has
authorized network tools, consult official documentation for version-sensitive
compiler errors or API support; otherwise use supplied feedback and retain
uncertainty.

## Output

Return exactly one JSON object matching outputSchema:

```json
{
  "edits": [
    {
      "path": "<one exact path from editablePaths in context/input.json>",
      "content": "The complete repaired Python source, JSON-escaped"
    }
  ],
  "reason": "The reported defect, the minimal repair and the invariant preserved"
}
```

A supported repair supplies one complete replacement per changed file from editablePaths. Do not edit task or
comparison files, introduce tests, timing code or external writes, or emit
placeholders. When no supported repair exists, return an empty edits array and
an explicit reason. Uncertainty is not a successful repair. Return JSON only,
without fences or surrounding prose; the Policy decides whether to continue.
