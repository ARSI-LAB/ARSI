"""Correctness test for the kernel-opt example task (vector add)."""

import sys

import torch

from problem import Model, get_inputs, get_init_inputs

try:
    from kernel import kernel_function
except ImportError:
    from input import kernel_function


def test_kernel():
    device = "npu"
    torch.manual_seed(0)
    model = Model(*get_init_inputs()).to(device)
    inputs = get_inputs()
    reference = model(*inputs)
    candidate = kernel_function(*inputs)
    assert candidate.shape == reference.shape, (
        f"shape mismatch: {candidate.shape} vs {reference.shape}"
    )
    assert candidate.dtype == reference.dtype, (
        f"dtype mismatch: {candidate.dtype} vs {reference.dtype}"
    )
    torch.testing.assert_close(candidate, reference, rtol=1e-3, atol=1e-3)


if __name__ == "__main__":
    sys.exit(test_kernel())
