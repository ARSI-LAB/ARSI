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

# Repair the last failed Triton-Ascend candidate

Fix the supplied failed candidate using its corresponding Evaluator diagnostics.
The editable input.py is the latest failed candidate, not the stage-entry source.
The task, current analysis, previous summaries and comparison sources are read-only.
Use the supplied Triton-Ascend guidelines and preserve the fixed task contract.

First identify the specific compile, entry/interface or numerical check failure.
Correct that defect with the smallest coherent change. Preserve the optimization
hypothesis and other behavior where possible; do not add unrelated performance
changes while correctness is unresolved. If the failure cannot be attributed to
the candidate, do not invent a repair or claim that a timeout/unknown cleanup is
an operator defect. Device execution belongs to the Evaluator and Policy.

Preserve kernel_function's public signature, output shape/dtype/layout/device,
aliasing and input-mutation rules. Keep required wrapper operations, allocation
ownership and NPU initialization guards. Preserve the exact clone/transpose/view
index mapping. Do not reconstruct ranks or exchange equal-sized axes by guesswork.
Do not replace existing Triton computation with newly introduced PyTorch compute,
weaken the task/tests, change tolerances, manufacture measurements or bypass checks.

Use @triton.jit for kernels and helpers. No CUDA assumptions, host tl.\* calls,
unsupported language APIs or placeholder implementations. Ensure each load/store
is in bounds or correctly masked, every output is written on a fresh call, and
launch arguments correspond to the current entry parameters or supported compiler
options exactly once. Generic fusion/GEMM examples do not authorize changing the
existing public caller or replacing the selected operator's implementation.

## Output

Return the complete JSON object required by outputSchema:

```json
{
  "edits": [
    {
      "path": "input.py",
      "content": "The complete repaired Python source, JSON-escaped"
    }
  ],
  "reason": "Identify the reported failure, explain the repair and the invariant preserved"
}
```

For a supported repair, edits must contain exactly one entry with path input.py
and content containing the complete repaired Python file. Do not split one
file replacement into multiple edits.

Edit only input.py. Return JSON only, without a Markdown fence or prose, and do
not return a Python code block. A remaining uncertainty is not a successful
repair. When no supported modification exists, return an empty edits array and
an explicit reason; the Policy decides whether to end the repair attempt.
