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
# BEFORE: invariant constants and the broadcast load remain inside both loops.
# ============================================================================
# Inside an existing @triton.jit kernel for [Z,Y,X] output.
# Assume broad_ptr and in_out_ptr do not alias.
x = (tl.program_id(0) * BLOCK_X + tl.arange(0, BLOCK_X))[None, None, :]
for z_start in range(0, Z, BLOCK_Z):
    z = (z_start + tl.arange(0, BLOCK_Z))[:, None, None]
    for y_start in range(0, Y, BLOCK_Y):
        y = (y_start + tl.arange(0, BLOCK_Y))[None, :, None]
        mask = (z < Z) & (y < Y) & (x < X)
        offsets = (z * Y + y) * X + x
        broad = tl.load(broad_ptr + z * X + x,
                        (z < Z) & (x < X), other=0)
        scale = tl.full([1, 1, 1], 0.044715, tl.float16)
        bias = tl.full([1, 1, 1], 1.5957691216057308, tl.float16)
        value = tl.load(in_out_ptr + offsets, mask, other=0)
        tl.store(in_out_ptr + offsets,
                 (value + broad) * scale + bias, mask)


# ============================================================================
# AFTER: move each invariant to its outermost legal scope.
# ============================================================================
# Constants cross both loops; broadcast load crosses Y only.
# Assume broad_ptr and in_out_ptr do not alias, as in the before version.
x = (tl.program_id(0) * BLOCK_X + tl.arange(0, BLOCK_X))[None, None, :]
x_mask = x < X
base_z = tl.arange(0, BLOCK_Z)
base_y = tl.arange(0, BLOCK_Y)
scale = tl.full([1, 1, 1], 0.044715, tl.float16)
bias = tl.full([1, 1, 1], 1.5957691216057308, tl.float16)
for z_start in range(0, Z, BLOCK_Z):
    z = (z_start + base_z)[:, None, None]
    z_mask = z < Z
    broad = tl.load(broad_ptr + z * X + x,
                    z_mask & x_mask, other=0)
    for y_start in range(0, Y, BLOCK_Y):
        y = (y_start + base_y)[None, :, None]
        mask = z_mask & (y < Y) & x_mask
        offsets = (z * Y + y) * X + x
        value = tl.load(in_out_ptr + offsets, mask, other=0)
        tl.store(in_out_ptr + offsets,
                 (value + broad) * scale + bias, mask)
# Keep original arithmetic and dtype; measure after checking UB live ranges.
