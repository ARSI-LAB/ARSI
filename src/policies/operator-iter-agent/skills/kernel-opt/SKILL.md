# Kernel-Opt Domain Skill (Ascend NPU kernel optimization)

Role: domain knowledge injected into the RSI proposer context for the
kernel-opt scenario (policy.operator-iter-agent). It teaches what a good
candidate looks like — not how to drive RSI. The loop mechanics (versioning,
validity gate, p50 selection, budgets, resume) are enforced by RSI in
code; the proposer's entire responsibility is one candidate per round.

## Candidate model

- The candidate is the kernel source `input.py` plus the tiling parameters
  in `config.json` — exactly the files in the editable scope. `input.py`
  must declare `def kernel_function(...)`: the evaluator loads the module,
  calls `kernel_function` directly with the task contract's input tensors
  (task/problem.py builds them in declared order), and compares the
  returned tensor against the torch reference. Keep the entry point's name
  and parameter order stable; a candidate that changes the callable's
  shape cannot be measured.
- Tiling is read at runtime from `config.json` (resolved relative to
  `__file__`, e.g. the `_tiling()` helper), never hardcoded into the
  kernel body, so a config-only round measures without touching the
  source. Constexpr/tile parameter names must stay aligned with the
  `config.json` keys.
- Migrating a captured inductor kernel: wrap it behind `kernel_function` —
  keep the math, rename inductor argument names
  (`x0_numel`, `X0BLOCK`, ...) to the wrapper's own tiling/size names, and
  derive the launch grid from the `config.json` tiling inside the wrapper.
  There is no external binding harness or wrapper.py: the module itself is
  the interface.
- Case ownership: the cases live in `task/task.json`
  (`rsi.kernel-task/v1`); a `cases.json` in the workspace only feeds the
  lifecycle start precheck. Never propose editing `task/` or the case
  definitions; coverage questions belong to the workload owner.
- One change per round: either one structural rewrite or one tiling/config
  adjustment. RSI measures every candidate, and unmeasured changes score
  nothing.

## Ascend NPU constraints (hard rules)

- API boundary: use `triton.language` standard plus
  `triton.language.extra.cann.extension` (insert*slice/extract_slice,
  gather_out_to_ub, scatter_ub_to_out, indirect_load/indirect_store) and the
  supported `tl.custom_op` subset. Indices/lengths/offsets are int32 unless a
  stride requires int64. No `tl.barrier` (use `tl.atomic*\*`/device_assert).
- Grid: strided loops (`for pid in range(pid, NUM_BLOCKS, NUM_CORE)`) instead
  of `triton.cdiv` grids; flatten multi-dimensional tasks inside the kernel.
  Pure vector kernels use `grid = (num_vectorcore,)`; CV-fused kernels use
  `(num_aicore, num_vectorcore // 2)`.
- Tiling: BLOCK sizes within UB capacity; reduce BLOCK before adding
  BLOCK_SIZE_SUB splits. Tail-axis alignment: vector kernels need >= 32-byte,
  CV-fused kernels >= 512-byte alignment; otherwise use axis-borrowing
  transpose only when `numel * element_bytes % 256 == 0`.
- Launch-time compile safety: a tiling that fails the CANN compiler
  surfaces as a compile-failed assessment (candidateValid 0, a stale
  round), while a source so broken it fails the lifecycle build aborts the
  whole run — never submit a half-edited kernel. On the triton-ascend
  3.2.x / torch_npu 2.7.x pairing, `*_SUB` equal to the runtime
  BLOCK (single-iteration inner loops) can fail `hivm-plan-memory` with the
  default multi-buffer planning; keep `*_SUB` strictly smaller than its BLOCK
  and always pass explicit `num_warps`/`num_stages` in config.json. Change one
  tiling dimension per round and stay in the neighborhood of a known-good
  config before exploring aggressively.
- Discrete memory: never scalar `tl.load(ptr + idx)`; load contiguous blocks
  into UB and select with `tl.gather`, preferably the extension ops.
- Accumulators are fp32, never fp16. Every load/store carries a mask.
- max-autotune over hand-written search when possible; `config.json` holds
  a single tiling assignment, not a search space — explore it one
  dimension per round through successive rounds instead of bundling a
  cartesian product into one candidate.
- Compile mode (950): default `simd_simt_template`; `tl.sin`/`tl.cos` with
  fp16/fp32 forces mixed mode; bf16 stays SIMD. Do not hardcode
  `simd_only`.

## Optimization direction by bottleneck

- memory-bound: fewer load/store passes, merged access, UB-resident select.
- compute-bound: raise vector-instruction share, avoid scalar loops, tune
  BLOCK via max-autotune.
- launch-bound: keep a single kernel, grid within `num_vectorcore`, merge
  small operators.

## Deterministic defenses (context)

The lifecycle precheck runs an AST allow-list scan on every kernel source,
and the evaluator's `candidateValid` metric is a hard gate: a candidate
that fails any task-contract check (compile, shape, dtype, layout,
independent output, unmodified inputs, numerical) on any case is
infeasible and can never be selected regardless of speed; selection is on
the `latencyMs` p50. Treat scan or gate failures in the evidence as
binding feedback: fix the named violation in the next proposal instead of
retrying the same shape.
