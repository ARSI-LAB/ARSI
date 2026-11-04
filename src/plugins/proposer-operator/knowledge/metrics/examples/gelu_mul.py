import torch
import triton
import triton.language as tl


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

@triton.jit
def _tanh(x):
    """Tanh implemented using sigmoid (official Triton approach)."""
    return 2.0 * tl.sigmoid(2.0 * x) - 1.0


@triton.jit
def _gelu_tanh(x):
    """GELU with tanh approximation."""
    sqrt_2_over_pi = 0.7978845608028654  # sqrt(2/pi)
    coeff = 0.044715
    inner = sqrt_2_over_pi * (x + coeff * x * x * x)
    return 0.5 * x * (1.0 + _tanh(inner))


@triton.jit
def _gelu_erf(x):
    """GELU with exact erf."""
    return 0.5 * x * (1.0 + tl.erf(x * 0.7071067811865475))  # 1/sqrt(2)


# ---------------------------------------------------------------------------
# Kernel
# ---------------------------------------------------------------------------

@triton.autotune(
    configs=[
        # 策略 A：BLOCK_D 尽量大，d 维度不循环
        triton.Config({"BLOCK_M": 24, "BLOCK_D": 128, "multibuffer": True}),
        triton.Config({"BLOCK_M": 24, "BLOCK_D": 256, "multibuffer": True}),
        triton.Config({"BLOCK_M": 16, "BLOCK_D": 512, "multibuffer": True}),
        triton.Config({"BLOCK_M": 24, "BLOCK_D": 512, "multibuffer": True}),
        triton.Config({"BLOCK_M": 8, "BLOCK_D": 1536, "multibuffer": True}), 
        triton.Config({"BLOCK_M": 8, "BLOCK_D": 1024, "multibuffer": True}),  
        triton.Config({"BLOCK_M": 4, "BLOCK_D": 3072, "multibuffer": True}),
        triton.Config({"BLOCK_M": 4, "BLOCK_D": 2048, "multibuffer": True}),
        triton.Config({"BLOCK_M": 2, "BLOCK_D": 4096, "multibuffer": True}),
    ],
    key=["M", "D"],
)

@triton.jit
def _gelu_mul_kernel(
    output_ptr: tl.tensor,
    input_ptr: tl.tensor,
    M: tl.int32,
    D: tl.int32,
    stride_io: tl.int32,
    stride_oo: tl.int32,
    USE_TANH: tl.constexpr,
    BLOCK_M: tl.constexpr,
    BLOCK_D: tl.constexpr,
):
    """1D grid: each program handles multiple [BLOCK_M, BLOCK_D] tiles via for-loops.

    Grid: (64,).
    """
    pid = tl.program_id(0)

    # ========== 唯一修改开始 ==========
    # 删除原来的硬编码常量 NCORES: tl.constexpr = 64
    # 改为动态获取当前 grid 的大小（即启动时传入的核心数）
    ncores = tl.num_programs(0)
    rows_per_core = tl.cdiv(M, ncores)
    # ========== 唯一修改结束 ==========

    row_start = pid * rows_per_core
    row_end = tl.minimum(row_start + rows_per_core, M)

    for col_start in range(0, D, BLOCK_D):
        cols = col_start + tl.arange(0, BLOCK_D)
        mask_d = cols < D

        for cur_row in range(row_start, row_end, BLOCK_M):
            rows = cur_row + tl.arange(0, BLOCK_M)

            mask_m = rows < row_end
            mask_2d = mask_m[:, None] & mask_d[None, :]

            # pointer arithmetic in int32 (avoid int64 scalar ops on NPU)
            row_base = input_ptr + rows[:, None] * stride_io
            x1_ptrs = row_base + cols[None, :]
            x2_ptrs = row_base + D + cols[None, :]

            x1 = tl.load(x1_ptrs, mask=mask_2d).to(tl.float32)
            x2 = tl.load(x2_ptrs, mask=mask_2d).to(tl.float32)
            
            if USE_TANH:
                x1_gelu = _gelu_tanh(x1)
            else:
                x1_gelu = _gelu_erf(x1)

            result = x1_gelu * x2

            out_base = output_ptr + rows[:, None] * stride_oo
            out_ptrs = out_base + cols[None, :]
            tl.store(out_ptrs, result, mask=mask_2d)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def triton_gelu_mul(
    input: torch.Tensor,
    approximate: str = "none",
) -> torch.Tensor:
    """Split input along last dim, apply GELU to left half, multiply with right half.

    Uses 1D grid with 64 cores, each processing a chunk of rows in a loop.

    Args:
        input: Tensor of shape ``[..., 2d]``, ndim 2–8.
               dtypes: float32, float16, bfloat16.
        approximate: ``"none"`` (erf) or ``"tanh"``.

    Returns:
        Tensor of shape ``[..., D]``, same dtype/device as input.
    """
    if input.ndim < 2 or input.ndim > 8:
        raise ValueError(f"input must have 2–8 dims, got {input.ndim}")
    last_dim = input.shape[-1]
    if last_dim % 2 != 0:
        raise ValueError(f"last dim must be even (2d), got {last_dim}")
    if approximate not in ("none", "tanh"):
        raise ValueError(f"approximate must be 'none' or 'tanh', got '{approximate}'")

    D = last_dim // 2
    out_shape = input.shape[:-1] + (D,)

    if input.is_contiguous():
        input_2d = input.view(-1, 2 * D)
    else:
        input_2d = input.contiguous().view(-1, 2 * D)

    output_2d = torch.empty(
        input_2d.shape[0], D,
        dtype=input.dtype,
        device=input.device
    )

    M = input_2d.shape[0]
    use_tanh = (approximate == "tanh")

    # 这里已经正确地从硬件读取了向量核心数，并作为 grid 大小传入
    device_properties = triton.runtime.driver.active.utils.get_device_properties(input.device)
    ncores = device_properties.get("num_vectorcore", -1)
    grid = (ncores,)

    _gelu_mul_kernel[grid](
        output_2d,
        input_2d,
        M,
        D,
        input_2d.stride(0),
        output_2d.stride(0),
        USE_TANH=use_tanh,
        hfusion_enable_multiple_consumer_fusion=True,
    )

    return output_2d.view(out_shape)