# User hardware context

The target device and its specifications are unknown until supplied by the user.
Replace unknown values with verified details before starting an experiment.
Missing information must not be invented.

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
