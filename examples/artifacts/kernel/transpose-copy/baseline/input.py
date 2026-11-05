import torch
import torch_npu
import triton
import triton.language as tl

if not torch_npu.npu.is_initialized() and torch_npu.npu._is_in_bad_fork():
    torch_npu.npu._initialized = True

BEST_CONFIG = {"T0BLOCK": 7, "T0BLOCK_SUB": 1, "Z1BLOCK_SUB": 16, "Y2BLOCK_SUB": 80, "X3BLOCK_SUB": 8, "compile_mode": "simd_simt_template", "multibuffer": True, "split_axis": [0], "split_blocks": [7], "num_warps": 1, "num_stages": 2, "configs_hash": "b39db9b8fde212e8135ca90cd5cf41ffbba66fbd2c06515486d517ea0a872c76", "found_by_coordesc": False, "time_taken_ms": 1886, "triton_cache_hash": None}

@triton.jit
def triton_poi_fused_clone_transpose_view_162(in_ptr0, out_ptr0, t0_numel, z1_numel, y2_numel, x3_numel, T0BLOCK, T0BLOCK_SUB: tl.constexpr, Z1BLOCK_SUB: tl.constexpr):
    y2_numel = 80
    Y2BLOCK_SUB: tl.constexpr = 80
    x3_numel = 8
    X3BLOCK_SUB: tl.constexpr = 8
    t0_offset = tl.program_id(0) * T0BLOCK
    base_t0 = tl.arange(0, T0BLOCK_SUB)
    loops_t0 = (T0BLOCK + T0BLOCK_SUB - 1) // T0BLOCK_SUB
    base_z1 = tl.arange(0, Z1BLOCK_SUB)
    loops_z1 = (z1_numel + Z1BLOCK_SUB - 1) // Z1BLOCK_SUB
    base_y2 = tl.arange(0, Y2BLOCK_SUB)
    base_x3 = tl.arange(0, X3BLOCK_SUB)
    for loop_t0 in range(loops_t0):
        t0 = t0_offset + (loop_t0 * T0BLOCK_SUB) + base_t0[:, None, None, None]
        t0_mask = t0 < min(T0BLOCK + t0_offset, t0_numel)
        for loop_z1 in range(loops_z1):
            z1 = (loop_z1 * Z1BLOCK_SUB) + base_z1[None, None, :, None]
            z1_mask = z1 < z1_numel
            y2 = base_y2[None, :, None, None]
            y2_mask = y2 < y2_numel
            x3 = base_x3[None, None, None, :]
            x3_mask = x3 < x3_numel
            tmp0 = tl.load(in_ptr0 + (x3 + 8 * z1 + 640 * y2 + 51200 * t0), t0_mask & x3_mask & y2_mask & z1_mask)
            tl.store(out_ptr0 + (x3 + 8 * y2 + 640 * z1 + 51200 * t0), tmp0, t0_mask & x3_mask & y2_mask & z1_mask)

def _parse_grid_and_tiling(kernel, numels, cfg):
    cfg = dict(cfg)
    split_axis = list(cfg.pop("split_axis", ()))
    split_blocks = list(cfg.pop("split_blocks", ()))
    grid = []
    for i, axis in enumerate(split_axis):
        numel = numels[axis]
        block = split_blocks[i] if i < len(split_blocks) else None
        grid.append(numel if block in (None, 1) else (numel + block - 1) // block)
    grid = tuple(grid) + (1,) * (3 - len(grid))
    constexpr_names = {kernel.arg_names[i] for i in kernel.constexprs}
    tiling_kwargs = {k: v for k, v in cfg.items() if k in constexpr_names}
    known_compiler_options = {"num_warps", "num_stages", "num_ctas", "compile_mode", "multibuffer", "enable_auto_bind_sub_block", "enable_hivm_auto_cv_balance", "tile_mix_cube_loop", "tile_mix_vector_loop", "enable_mixed_cv", "auto_blockify_size", "sync_solver", "unit_flag", "inject_barrier_all", "inject_block_all", "disable_auto_inject_block_sync", "limit_auto_multi_buffer_only_for_local_buffer", "limit_auto_multi_buffer_of_local_buffer", "set_workspace_multibuffer", "stream", "enable_linearize", "enable_nd2nz_on_vector", "enable_persistent", "enable_fp_fusion"}
    extra_kwargs = {k: v for k, v in cfg.items() if k in known_compiler_options}
    return grid, tiling_kwargs, extra_kwargs

def kernel_function(in_ptr0: torch.Tensor) -> torch.Tensor:
    out_ptr0 = torch.empty((381, 80, 80, 8), dtype=in_ptr0.dtype, device=in_ptr0.device)
    t0_numel, z1_numel, y2_numel, x3_numel = 381, 80, 80, 8
    grid, tiling_kwargs, extra_kwargs = _parse_grid_and_tiling(triton_poi_fused_clone_transpose_view_162, [t0_numel, z1_numel, y2_numel, x3_numel], BEST_CONFIG)
    triton_poi_fused_clone_transpose_view_162[grid](in_ptr0, out_ptr0, t0_numel, z1_numel, y2_numel, x3_numel, BEST_CONFIG["T0BLOCK"], **tiling_kwargs, **extra_kwargs)
    return out_ptr0
