<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0

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

# Diagnose operator source

Inspect the supplied stage-entry source, fixed task contract, authorized Target,
and hardware observations. Infer the implementation language and execution
backend from these inputs. Diagnose source-visible opportunities; do not assume
an accelerator vendor, compiler feature, memory hierarchy, or programming model.
Source and task files are read-only for this action.

Use only these diagnostic categories when their conditions are visible:

- `core_partition`: the parallel work partition, launch geometry, or work assigned
  to each execution unit is poorly matched to the supplied workload or hardware.
- `pass_merge`: separate passes repeatedly move the same intermediate through
  memory, and combining compatible passes could remove that traffic while
  preserving every consumer and intermediate precision boundary.
- `loop_invariant_hoisting`: repeated work depends only on outer-loop values or
  fixed parameters and can move out of an inner loop without changing behavior.
- `masked_accumulator`: a masked update repeatedly selects an unchanged
  accumulator even though inactive inputs already contribute the neutral value.
  Consider simplification only when masks, effective precision and numerical
  behavior remain equivalent.

Support each issue with a continuous verbatim range of the supplied source.
Merge duplicate observations. Do not force a category onto an incompatible
operator; return no issues when none applies. Static analysis cannot establish
measured bottlenecks, generated instructions, device timings or speedups. Missing
hardware facts remain unknown.

If the bound Agent provides authorized network tools, consult official compiler,
runtime or hardware documentation to resolve version or API uncertainty. Otherwise
use the supplied and retrieved materials, preserve uncertainty, and do not claim
that an online lookup occurred. External references guide hypotheses; they do
not override the task or establish measurements.

## Output

Return one JSON object matching outputSchema, with only `issues`:

```json
{
  "issues": [
    {
      "issue_type": "core_partition",
      "issue_summary": "A source-visible work-partition opportunity",
      "problematic_code": [
        "One continuous verbatim range from the supplied source"
      ],
      "evidence": ["An observation supported by that exact range"]
    }
  ]
}
```

The example illustrates the format; use actual supplied source in every excerpt.
Do not reword, trim or invent an excerpt. Use separate ranges for distant code.
If no supported issue exists, return {"issues":[]}.
Return JSON only, without fences, edits, measurements or surrounding prose.
