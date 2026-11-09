#!/usr/bin/env python3
"""Mock agent bridge for the kernel-opt smoke run's memory reflection.

One JSON request on stdin ({goal, prompt, input, files, outputSchema,
maxModelCalls}), one JSON response on stdout - the same seam as
kernel-bridge.py, without any model call. The response consolidates a
deterministic lesson into memory.md so the memory wiki's seed/persist
directory exercises the full cross-run round trip.
"""

import json
import sys


def main() -> None:
    json.load(sys.stdin)
    response = {
        "modelCalls": 1,
        "edits": [
            {
                "path": "memory.md",
                "content": (
                    "# Kernel-opt memory wiki\n\n"
                    "## Failure mechanisms\n\n"
                    "- Lifecycle precheck rejections (checksum gate) surface as"
                    " failed measurements and count as stale rounds; they are"
                    " never compared.\n"
                    "- The mock smoke poisons BLOCK_SIZE=256: narrower blocks"
                    " than 512 were rejected by the precheck on this deployment.\n\n"
                    "## Tiling patterns\n\n"
                    "- Dropping the num_stages pass-through on the elementwise"
                    " add measured valid and improved p50.\n"
                ),
            }
        ],
        "reason": "Recorded the mock run's rejection mechanism and the adopted tiling lesson.",
    }
    print(json.dumps(response))


if __name__ == "__main__":
    main()
