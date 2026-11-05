# User hardware context

This initial document uses hardware fields from the ngo-agent template. The target
device and its specifications are unknown until supplied by the user. Replace
unknown values with verified details before starting an experiment. Missing
information must not be invented.

Source: ngo-agent commit `e8bf53c0d9d70200d235c761f5e7472118b8e898`,
`src/ngo_agent/kernel_agent/kernel_perf_agent/kernel_opt/diagnose_prompt/npu_specs_database.py`.

| Hardware field | User-provided value |
| -------------- | ------------------- |
| name           | Unknown target NPU  |
| vector_count   | Unknown             |
| cube_count     | Unknown             |
| ub_size_kb     | Unknown             |
| L1_cache_kb    | Unknown             |
| L2_cache_mb    | Unknown             |
| hbm_gb         | Unknown             |

These are user-editable context values, not implicit defaults for programmatic
utilization calculations. Task semantics, correctness checks, and the authorized
editing scope remain binding.

Additional user notes:

- Add relevant execution constraints or verified hardware details here.
