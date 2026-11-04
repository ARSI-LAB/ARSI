#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
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
# BEFORE: pass 1 stores a shared intermediate and pass 2 reloads it.
# ============================================================================
# pass 1: accumulate per-row tmp40, store it to in_out_ptr0, and accumulate sumsq
for loop_r1 in range(loops_r1):
    ...
    tmp40 = ...  # per-row result reused by pass 2
    tl.store(in_out_ptr0 + (r1 + 6519 * x0), tmp40, r1_mask & x0_mask)
tmp46 = tl.sum(_tmp46, 1).reshape(X0BLOCK_SUB, 1)

# pass 2: reload the stored intermediate and complete the row-wise norm
for loop_r1 in range(loops_r1):
    ...
    tmp49 = tl.load(in_out_ptr0 + (r1 + 6519 * x0), r1_mask & x0_mask, other=0.0)
    tmp61 = tmp49 * inv * tmp58
    tl.store(in_out_ptr0 + (r1 + 6519 * x0), tmp61, r1_mask & x0_mask)


# ============================================================================
# AFTER: input_opt.py keeps the intermediate on chip in a single pass.
# ============================================================================
# --- After (input_opt.py): one pass keeps the intermediate on chip ---
# persistent grid: each program strides over all row tiles
for x0 in range(pid, x0_numel, NCORES):
    row_off = 6519 * x0
    gated = tmp41 * tmp40r

    sumsq = tl.sum(gated * gated, 0)
    mean = sumsq * (1.0 / 6519.0)
    inv = tl.rsqrt(mean + 9.999999747378752e-06)

    tmp61 = gated * inv * tmp58
    tl.store(in_out_ptr0 + (base_r1 + row_off), tmp61.to(tl.bfloat16), r1_mask)
