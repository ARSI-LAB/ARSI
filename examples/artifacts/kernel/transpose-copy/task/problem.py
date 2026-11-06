import torch
import torch_npu

torch._inductor.config.triton.codegen_upcast_to_fp32 = False


class Model(torch.nn.Module):
    def __init__(self):
        super(Model, self).__init__()

    def forward(self, cat_195):
        view_358 = torch.ops.aten.reshape.default(cat_195, [-1, 80, 80, 8])
        permute_578 = torch.ops.aten.permute.default(view_358, [0, 2, 1, 3])
        clone_85 = torch.ops.aten.clone.default(
            permute_578, memory_format=torch.contiguous_format
        )
        return clone_85


dtype = torch.float16
device = "npu"


def get_inputs():
    cat_195 = torch.empty((381, 51200), dtype=dtype, device=device).uniform_(-1, 1)
    return [cat_195]


def get_init_inputs():
    return []
