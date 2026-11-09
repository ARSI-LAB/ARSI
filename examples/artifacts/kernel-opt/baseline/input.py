"""Baseline captured kernel (H0): plain strided vector add.

Example placeholder for a captured Triton kernel in the ngo-agent snapshot
layout. The SDK evaluator loads this module and calls kernel_function with the
task contract inputs (two float16 tensors of shape (512, 256, 512)); the
returned tensor is compared against the torch reference in task/problem.py.

Tiling parameters come from config.json next to this file (staged alongside it
by the evaluator; resolved relative to __file__, never the cwd). The
optimization goal is a same-signature variant with better tiling/UB usage
under the Ascend constraints; correctness is adjudicated only by the evaluator
assessment on the declared task cases.
"""

import json
import os

import torch
import triton
import triton.language as tl


@triton.jit
def vector_add(
    x_ptr,
    y_ptr,
    out_ptr,
    n_elements,
    BLOCK_SIZE: tl.constexpr,
):
    pid = tl.program_id(axis=0)
    block_start = pid * BLOCK_SIZE
    offsets = block_start + tl.arange(0, BLOCK_SIZE)
    mask = offsets < n_elements
    x = tl.load(x_ptr + offsets, mask=mask)
    y = tl.load(y_ptr + offsets, mask=mask)
    tl.store(out_ptr + offsets, x + y, mask=mask)


def _tiling():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            config = json.load(handle)
    except (OSError, ValueError):
        config = {}
    return {
        "BLOCK_SIZE": int(config.get("BLOCK_SIZE", 1024)),
        "num_warps": int(config.get("num_warps", 4)),
        "num_stages": int(config.get("num_stages", 2)),
    }


def kernel_function(x: torch.Tensor, y: torch.Tensor) -> torch.Tensor:
    out = torch.empty_like(x)
    n_elements = x.numel()
    tiling = _tiling()
    grid = (triton.cdiv(n_elements, tiling["BLOCK_SIZE"]),)
    vector_add[grid](
        x,
        y,
        out,
        n_elements,
        BLOCK_SIZE=tiling["BLOCK_SIZE"],
        num_warps=tiling["num_warps"],
        num_stages=tiling["num_stages"],
    )
    return out
