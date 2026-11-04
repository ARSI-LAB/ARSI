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
# BEFORE: a loop-carried accumulator guarded by a full-width tl.where select
# on every iteration.
# ============================================================================
# Inside an existing @triton.jit kernel that accumulates a row statistic
# across a tiled loop. Every load feeding the summand uses other=0.0.
acc = tl.full([BLOCK_M, BLOCK_N], 0, tl.float32)
for loop_n in range(loops_n):
    n = loop_n * BLOCK_N + base_n[None, :]
    n_mask = n < n_numel
    a = tl.load(a_ptr + n, n_mask, other=0.0).to(tl.float32)
    b = tl.load(b_ptr + n, n_mask, other=0.0).to(tl.float32)
    delta = a * b
    # Redundant guard: masked lanes already contribute 0.0 through
    # other=0.0, so acc + delta equals the guarded update everywhere.
    acc = tl.where(n_mask, acc + delta, acc)
stat = tl.sum(acc, 1)


# ============================================================================
# AFTER (loop kept, e.g. BLOCK_N < n_numel): drop the select, keep the add.
# ============================================================================
acc = tl.full([BLOCK_M, BLOCK_N], 0, tl.float32)
for loop_n in range(loops_n):
    n = loop_n * BLOCK_N + base_n[None, :]
    n_mask = n < n_numel
    a = tl.load(a_ptr + n, n_mask, other=0.0).to(tl.float32)
    b = tl.load(b_ptr + n, n_mask, other=0.0).to(tl.float32)
    acc = acc + a * b  # masked lanes add 0.0
stat = tl.sum(acc, 1)


# ============================================================================
# AFTER (loop removed, e.g. pass_merge deleted a degenerate loop with
# BLOCK_N >= n_numel): the accumulator collapses into a single tl.sum.
# ============================================================================
n = base_n[None, :]
n_mask = n < n_numel
a = tl.load(a_ptr + n, n_mask, other=0.0).to(tl.float32)
b = tl.load(b_ptr + n, n_mask, other=0.0).to(tl.float32)
# No tl.full zero init, no add chain, no select — one reduction.
stat = tl.sum(a * b, 1)

# Keep the tl.where when the zero-contribution proof fails, for example a
# contributing load without other=0.0 or a summand reused from an earlier
# unmasked computation: masked lanes may then hold stale or garbage values.
