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

# Generate one static optimization candidate

Produce one reliable Triton-Ascend candidate for the supplied fixed operator.
Use the stage-entry source as this attempt's parent. The supplied static diagnosis
and matching knowledge explain possible mechanisms; previous summaries record
what was tried and observed. Address one primary hypothesis with a small,
traceable transformation. After a verified no-gain attempt, choose a different
supported transformation rather than repeating the same change.

Retrieved examples are implementation references, not drop-in replacements.
Preserve the current public kernel_function signature, output count, shapes,
dtypes, device, layout/strides, aliasing and input-mutation contract. Preserve
allocation ownership, required wrapper operations and runtime initialization.
The current task contract and authorized Target take precedence over examples
and generic programming references. Use only exact paths from `editablePaths` in `context/input.json` for edits; all task files,
comparison sources and prior summaries are read-only.

Classify the operator before changing it: elementwise, reduction, transpose/copy,
or mixed matrix/pointwise. Match the transformation to that structure. Do not
introduce a persistent grid without complete coverage, change rounding behavior,
or combine unrelated tiling, math and launch changes in a single hypothesis.
Use actual supplied hardware information; do not manufacture core counts or
buffer capacities from a reference example.

Keep an attribution anchor: when changing source-level math, preserve indexing,
tiling and launch configuration unless the diagnosed transformation requires a
specific coordinated change. For pass merge, preserve effective precision at
store/load boundaries and track every consumer of an intermediate. For invariant
hoisting, demonstrate that the moved expression does not depend on the inner
loop. For masked accumulators, preserve neutral masked values and output coverage.

No profiler-driven diagnosis is available in this static stage. Hardware metrics
must remain unknown unless supplied as measured evidence. A proposal is a
hypothesis; only later Evaluator checks and timing can establish its result.
Never copy historical time_taken_ms metadata into a new measurement or claim.

## ASCEND/TRITON HARD REQUIREMENTS

1. Target backend is Triton-Ascend running on Ascend NPU.
2. Use `@triton.jit` for kernels and jit helpers. Never use `@tl.jit`.
3. Do not use CUDA APIs, CUDA stream APIs, GPU warp assumptions, or hardcoded CUDA constants.
4. Do not use unsupported Triton-Ascend APIs such as `tl.prefetch` or manual async-copy logic.
   Use `multibuffer=True` when transfer/compute overlap is appropriate.
5. Do not call the unsupported `tl.tanh`. Preserve an existing supported
   `torch_npu._inductor.runtime.triton_helpers.math.tanh` implementation unless an
   isolated A/B measurement proves that replacing it is beneficial and precision passes.
   Only when no supported helper is available, use the exact identity
   `2.0 * tl.sigmoid(2.0 * x) - 1.0`.
6. Do not replace hardware-native `tl.sigmoid`, `tl.rsqrt`, `tl.exp`, `tl.erf`, or other
   transcendental/math operations with approximations unless the diagnosis or history proves
   that exact change is the intended experiment. Avoid exp2-based sigmoid rewrites by default.
7. Do not use tensor `.any()` inside Triton kernels. Use bitwise operators `&` and `|` for
   Triton tensor masks. Every load/store must have a valid mask or be statically in bounds.
8. Do not cast FP32 inputs or accumulators to lower precision unless the original kernel already
   did so at that point or the output dtype requires the final cast.
9. Keep block tensor element counts below Triton's maximum tensor numel and within Ascend UB
   capacity. Avoid products like `BLOCK_M * BLOCK_N * num_live_tiles` that can exceed about
   1,048,576 Triton elements or the reported Unified Buffer capacity.
10. Do not add new runtime asserts about tensor rank, shape, contiguity, or strides unless the
    same assert already exists in CURRENT KERNEL. Use known sizes as local constants or
    `tl.constexpr` meta-parameters instead of rejecting valid inputs at runtime.
11. `tl.*` language functions are kernel-side only. In Python wrapper code, use Python integer
    arithmetic or Triton runtime helpers such as `triton.cdiv`; never call `tl.cdiv`,
    `tl.arange`, or other `tl.*` functions outside a `@triton.jit` function.
12. Do not infer the logical operator rank from storage tensors in the wrapper. Inductor wrappers
    may pass flattened, strided, or reinterpreted tensors whose `.ndim`/`.shape` differ from the
    logical shape. Preserve the CURRENT KERNEL allocation and stride/index mapping.
13. Avoid `view()`/`reshape()` assumptions for non-contiguous tensors unless CURRENT KERNEL
    already established the exact stride/layout. Prefer preserving existing `reinterpret_tensor`,
    `as_strided`, or `empty_strided` layout handling.
14. For clone/transpose/view kernels, preserve the exact source-to-destination index mapping and
    output allocation from CURRENT KERNEL. Do not infer a new tensor rank, swap equal-sized axes,
    or change output contiguity/stride unless the original wrapper already does that exact change.
15. Preserve initialization ownership. Do not move or rewrite an existing
    `torch_npu.npu._is_in_bad_fork()` guard, and never assign `_initialized` on a different object.
16. A candidate must be correct from a fresh first call. Autotune trials, warmups, or a previous
    launch must not prefill output elements that the selected configuration fails to write.

## LAUNCH CONFIG RULES

1. `BEST_CONFIG` may contain tiling meta-parameters and known compiler options.
2. Do not pass stale Inductor/search metadata to a Triton launch. Filter out keys such as
   `configs_hash`, `found_by_coordesc`, `time_taken_ms`, `triton_cache_hash`, `coordinate`,
   `benchmark_ms`, and any key not accepted by the launched kernel or compiler.
3. Avoid duplicate meta-parameters. A constexpr must be supplied exactly once; do not pass the
   same value both positionally and as a keyword, and do not define two names for the same tile.
4. If using `triton.Config`, put only kernel meta-parameters and supported compiler options in
   each config. Keep `num_warps` and `num_stages` consistent with how the launch wrapper forwards
   kwargs in this file.
   If a compiler option such as `multibuffer`, `compile_mode`, `num_warps`, or `num_stages`
   appears inside `triton.Config`, do not also pass that same option through `BEST_CONFIG`,
   `extra_kwargs`, or explicit launch kwargs. The same key must have one owner only.
   If an autotuned meta-parameter changes tile coverage, derive the launch grid from the
   selected `meta` value (for example `grid = lambda meta: (...)`). Never compute the grid
   once from a fixed default while autotune varies that tile size. Every config must cover
   the full output independently; correctness must not depend on data written by another
   autotune trial.
5. Recognized Triton-Ascend compiler options include:
   `num_warps`, `num_stages`, `num_ctas`, `compile_mode`, `multibuffer`,
   `enable_auto_bind_sub_block`, `enable_hivm_auto_cv_balance`,
   `tile_mix_cube_loop`, `tile_mix_vector_loop`, `enable_mixed_cv`,
   `hfusion_enable_multiple_consumer_fusion`, `auto_blockify_size`,
   `sync_solver`, `unit_flag`, `inject_barrier_all`, `inject_block_all`,
   `disable_auto_inject_block_sync`,
   `limit_auto_multi_buffer_only_for_local_buffer`,
   `limit_auto_multi_buffer_of_local_buffer`, `set_workspace_multibuffer`,
   `stream`, `enable_nd2nz_on_vector`,
   `enable_persistent`, `enable_fp_fusion`.

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
  "reason": "Source evidence; one main optimization hypothesis; concrete changes; what the Evaluator must verify"
}
```

The edited file must be complete and define kernel_function with the preserved
public signature. Include only imports, constants, helpers, kernels and wrapper
code required for that implementation; no tests, timing code or external writes.
Return one complete replacement per changed file from `editablePaths`. Do not edit read-only comparison or task files.
When no supported modification remains, return {"edits":[],"reason":"Explain why no supported change remains"}.

Return JSON only, without a Markdown fence or prose. Do not return a Python code
block. Do not emit placeholders, stubs or input/zero-tensor shortcuts. Before the
final answer, check tail coverage, masks, current wrapper semantics, launch kwargs
and preservation of the fixed output contract. State the hypothesis without
claiming an improvement before a real SDK measurement exists.
