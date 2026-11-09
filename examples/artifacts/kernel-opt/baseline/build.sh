#!/bin/bash
# Build step for the kernel-opt example: the candidate kernel is validated
# without assuming a live triton-ascend toolchain, so the build step honestly
# validates the sources and records the toolchain identity. The stamp is a
# function of the toolchain and build mode only: the lifecycle script digests
# build/ into modelIdentity, and the evaluator derives the measurement
# comparisonKey from it — a wall-clock timestamp would make every instance
# incomparable.
set -e
python3 -m py_compile input.py
test -f config.json
mkdir -p build
{
  cat /usr/local/Ascend/ascend_toolkit_install.info 2>/dev/null || true
  cat /usr/local/Ascend/cann-*/aarch64-linux/ascend_toolkit_install.info 2>/dev/null || true
  echo build=validation-only-triton-kernel
} > build/stamp.txt
