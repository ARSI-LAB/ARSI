"""
Pure Vector-Core GEMV: K-dimension blocked, persistent grid, no tl.dot.
Same API as original batched_dense_vec_jagged_2d_matmul.

NPU (Ascend DaVinci) tuning notes:
  - BLOCK_K (K 方向一次读多少行) 是 autotune 参数。
  - NPU 具有单核能力强，核数少的特点，对于Vector算子，grid 的配置固定为 grid(NCORES, ), NCORES 直接从硬件读取（num_vectorcore），不设置默认值。
  - 每个 config 使能 multibuffer，launch 时传 hfusion_enable_multiple_consumer_fusion=True。
  - 配置BLOCK，提高 kernel 每次计算的数据量，从而利用NPU的单核算力
  - 输入数据如果是 int64 需要预先转为 int32，NPU不支持 int64 会导致性能退化。
"""

import torch
import triton
import triton.language as tl

def get_autotune_config():
    return [
        triton.Config({"BLOCK_K": 32, "multibuffer": True}),
        triton.Config({"BLOCK_K": 64, "multibuffer": True}),
        triton.Config({"BLOCK_K": 128, "multibuffer": True}),
        triton.Config({"BLOCK_K": 256, "multibuffer": True}),
        triton.Config({"BLOCK_K": 512, "multibuffer": True}),
        triton.Config({"BLOCK_K": 1024, "multibuffer": True}),
    ]

def _get_ncores(device) -> int:
    """直接从硬件读取向量核心数（num_vectorcore），不设置默认值。"""
    ncores = triton.runtime.driver.active.utils.get_device_properties(device).get("num_vectorcore", -1)
    return int(ncores)


@triton.autotune(
    configs=get_autotune_config(),
    key=["N_max", "D"],
)
@triton.jit
def triton_batched_dense_vec_jagged_2d_matmul(
    # Original layout, unchanged
    dense_ptr,               # [B*H, N_max]
    values_ptr,              # [total_rows, H*D]
    offset_ptr,              # [B+1]
    output_ptr,              # [B*H, D]

    # Problem sizes
    H: tl.constexpr,
    B: tl.constexpr,
    N_max: tl.constexpr,
    D: tl.constexpr,

    # Pre-computed constants from wrapper (to avoid scalar ops in kernel)
    BLOCK_N: tl.constexpr,      # D
    TOTAL_TILES: tl.constexpr,  # H * B

    # Autotuned tile size
    BLOCK_K: tl.constexpr,      # how many K elements to load per iteration
):
    pid = tl.program_id(0)
    NCORES = tl.num_programs(0)  # dynamic grid size (hardware cores)

    NUM_K_TILES = tl.cdiv(N_max, BLOCK_K)  # still depends on autotuned BLOCK_K

    for tile_idx in range(pid, TOTAL_TILES, NCORES):
        head_idx = tile_idx // B 
        r = tile_idx % B 

        begin = tl.load(offset_ptr + r)
        end = tl.load(offset_ptr + r + 1)
        n_actual = end - begin
        n_actual = tl.minimum(n_actual, N_max)

        offs_n = tl.arange(0, BLOCK_N)

        offs_k = tl.arange(0, BLOCK_K)

        dense_row = r * H + head_idx
        dense_base = dense_ptr + dense_row * N_max

        values_base = (values_ptr +
                       begin * (H * D) +
                       head_idx * D)

        out_base = output_ptr + dense_row * D

        n_mask = offs_n < D

        # K-loop: all K segments are accumulated serially in this tile.
        acc = tl.zeros((BLOCK_N,), dtype=tl.float32)
        for kk in range(0, NUM_K_TILES):
            k_start = kk * BLOCK_K
            k_mask = k_start + offs_k < n_actual
            v_ptrs = (values_base +
                      (k_start + offs_k[:, None]) * (H * D) +
                      offs_n[None, :])
            v_mask = (k_start + offs_k[:, None] < n_actual) & (offs_n[None, :] < D)
            a = tl.load(dense_base + k_start + offs_k, mask=k_mask, other=0.0)  # [BK]
            v = tl.load(v_ptrs, mask=v_mask, other=0.0)  # [BK, BN]

            # K reduction: [BK,1] * [BK,BN] → sum(axis=0) → [BN]
            acc += tl.sum(a[:, None] * v, axis=0)

        tl.store(out_base + offs_n, acc, mask=n_mask)


def batched_dense_vec_jagged_2d_matmul(
    dense: torch.Tensor,        # [B*H, N_max]
    values: torch.Tensor,       # [total_rows, H*D]
    offset: torch.Tensor,       # [B+1]
) -> torch.Tensor:
    """
    Drop-in replacement for the original (same name, same API).

    Key changes from original:
      - K-dim blocking: load BK elements at once instead of 1
      - Persistent grid: (NCORES,) instead of (B*H*ceil(D/32),)
      - Pure Vector Core (no tl.dot / Cube Core)
      - BLOCK_K autotuned, BLOCK_N fixed to D aligned up to 16 (precomputed in wrapper)
      - NCORES directly from hardware (num_vectorcore), no default value
      - multibuffer enabled via hfusion_enable_multiple_consumer_fusion
    """
    offset = offset.to(torch.int32)
    B = offset.size(0) - 1
    H = dense.size(0) // B
    N_max = dense.size(1)
    D = values.size(-1) // H

    # Precompute constants that do not depend on autotuned BLOCK_K
    BLOCK_N = D
    TOTAL_TILES = H * B

    NCORES = _get_ncores(dense.device)

    output = torch.empty(B * H, D, device=dense.device, dtype=dense.dtype)

    grid = (NCORES,)
    triton_batched_dense_vec_jagged_2d_matmul[grid](
        dense,
        values,
        offset,
        output,
        H=H,
        B=B,
        N_max=N_max,
        D=D,
        BLOCK_N=BLOCK_N,
        TOTAL_TILES=TOTAL_TILES,
        hfusion_enable_multiple_consumer_fusion=True,
    )

    return output