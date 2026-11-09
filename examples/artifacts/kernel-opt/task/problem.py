"""Reference model for the kernel-opt example task: elementwise vector add.

The baseline captured kernel is a Triton vector add (baseline/input.py); the
SDK measures the candidate kernel against this torch reference under the task
contract. Case ids and seeds are carried over from baseline/cases.json
(fp16-512 / fp32-768 / fp16-1024); the kernel-task contract is per-task, so
every case measures the same float16 shape with its own seed.
"""

import torch
import torch_npu

torch._inductor.config.triton.codegen_upcast_to_fp32 = False


class Model(torch.nn.Module):
    def __init__(self):
        super().__init__()

    def forward(self, x, y):
        return x + y


dtype = torch.float16
device = "npu"


def get_inputs():
    x = torch.empty((512, 256, 512), dtype=dtype, device=device).uniform_(-1, 1)
    y = torch.empty((512, 256, 512), dtype=dtype, device=device).uniform_(-1, 1)
    return [x, y]


def get_init_inputs():
    return []
