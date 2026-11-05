<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

Source: ngo-agent@e8bf53c0d9d70200d235c761f5e7472118b8e898:src/ngo_agent/kernel_agent/triton_kernel_agent/templates/static_code_diagnosis_prompt.j2
Adaptation: Replaced Jinja interpolation with supplied RSI context and wrapped the upstream issues array in a strict JSON object; invalid responses do not become empty diagnoses.
-->

# Source-only Triton-Ascend diagnosis

Inspect the supplied stage-entry kernel source, fixed problem/contract and actual
hardware observations. Diagnose source-visible opportunities only. Do not assume
profiler counters, generated IR, device timings, bandwidth, or compiler behavior
that are not present in the supplied evidence. Missing hardware values remain unknown.
The source and task files are read-only for this action.

Diagnose only the following four issue types:

- `core_partition`: the visible one-dimensional grid, core-count selection, or
  per-program work assignment is too small, excessive, hard-coded, or otherwise
  poorly balanced for the supplied hardware.
- `pass_merge`: the same data or an unchanged pointer expression is loaded from
  or stored to GM repeatedly across passes, for example an intermediate written
  to a GM buffer in one pass and reloaded from the same buffer in a later pass,
  when the passes could be fused so the value stays on chip.
- `loop_invariant_hoisting`: a loop repeatedly loads or computes a value that
  depends only on outer-loop values or kernel parameters, and the load can be
  hoisted above the loop.
- `masked_accumulator`: a loop-carried accumulator is updated with a full-width
  tl.where select on every iteration, for example acc = tl.where(mask, acc +
  delta, acc) seeded by tl.full(..., 0, tl.float32), while every load feeding
  the accumulated expression uses other=0.0 so masked-out lanes already
  contribute zero and the select only re-selects values that are already
  present.

Report an issue only when a concrete source range supports it. Merge duplicate
observations, and return no issues when none of the four types applies. Do not
force a technique onto an incompatible operator structure.

## Output

Return one JSON object matching outputSchema, with exactly the field `issues`.
Each issue preserves the upstream diagnostic fields:

```json
{
  "issues": [
    {
      "issue_type": "core_partition",
      "issue_summary": "A concise description of a source-visible issue",
      "problematic_code": [
        "One continuous verbatim range of the supplied source"
      ],
      "evidence": ["A concise observation supported by that range"]
    }
  ]
}
```

Use a separate range for genuinely distant code. Never reword, trim, invent or
replace a problematic_code excerpt; it must occur literally in the supplied
source. A technique ID must be one of the four identifiers above. If there are no
issues, return {"issues":[]}.

Return JSON only, without a Markdown fence or surrounding prose. Do not return
edits, code replacements, measurements, or optimization claims. The JSON object
wrapper is required by the RSI Agent contract; the issues array is the static
diagnosis consumed by the Proposer.
