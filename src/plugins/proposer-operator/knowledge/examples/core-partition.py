#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ==============================================================================

# ============================================================================
# BEFORE: input.py uses a row-count-derived grid with one program per row.
# ============================================================================
def _parse_grid_and_tiling(kernel, numels, cfg):
    split_axis = list(cfg.pop("split_axis", ()))
    split_blocks = list(cfg.pop("split_blocks", ()))

    grid = [
        numels[axis]
        if block in (None, 1)
        else (numels[axis] + block - 1) // block
        for axis, block in zip(split_axis, split_blocks)
    ]
    grid = tuple(grid) + (1,) * (3 - len(grid))
    return grid


# ============================================================================
# AFTER: input_opt.py uses a hardware-sized persistent grid.
# ============================================================================
# --- After (input_opt.py) 1/3: size the grid to the physical vector-core count ---
ncores = int(
    triton.runtime.driver.active.utils.get_device_properties(buf6.device).get(
        "num_vectorcore", -1
    )
)
grid = (ncores,)


# --- After 2/3: read the persistent grid size inside the kernel ---
@triton.jit
def persistent_row_kernel(
    in_out_ptr0,
    x0_numel,
    r1_numel,
    R1BLOCK: tl.constexpr,
):
    pid = tl.program_id(0)
    NCORES = tl.num_programs(0)

    # --- After 3/3: persistent grid, each program strides over all row tiles ---
    # persistent grid: each program strides over all row tiles
    for x0 in range(pid, x0_numel, NCORES):
        row_off = r1_numel * x0
        # per-row loads + elementwise compute + row-wise reduction
        tl.store(in_out_ptr0 + (base_r1 + row_off), tmp61.to(tl.bfloat16), r1_mask)
