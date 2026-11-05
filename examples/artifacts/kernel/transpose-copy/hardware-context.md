# User hardware context

This initial document is derived from the ngo-agent template. These values are not
verified measurements of the current NPU. Review, edit, remove, or extend them
before starting an experiment. Missing information must not be invented.

Source: ngo-agent commit `e8bf53c0d9d70200d235c761f5e7472118b8e898`,
`src/ngo_agent/kernel_agent/kernel_perf_agent/kernel_opt/diagnose_prompt/npu_specs_database.py`.

| Template field | Template value    |
| -------------- | ----------------- |
| name           | ASCEND 950PR 128G |
| vector_count   | 56                |
| cube_count     | 28                |
| ub_size_kb     | 248               |
| L1_cache_kb    | 512               |
| L2_cache_mb    | 128               |
| hbm_gb         | 128               |

These are user-editable context values, not implicit defaults for programmatic
utilization calculations. Task semantics, correctness checks, and the authorized
editing scope remain binding.

Additional user notes:

- Add relevant execution constraints or verified hardware details here.
