# Repair startup before measuring the baseline

Read the failure under `context/input.json`, the current `candidate/tuning.json`, and the `vllm-ascend-tuning` skill. Use the installed option catalog under `target.parameterCatalog` in `context/input.json`. Ask `enablement-reviewer` for a focused diagnosis when the failure could have multiple causes.

The goal is a usable baseline on the same deployed model, NPU assignment, engine and AISBench workload. For confirmed memory pressure, reduce batching pressure with the smallest plausible supported parameter change. For an unsupported optional flag, remove that flag and use the installed default. An incomplete benchmark result can require workload or deployment repair outside the authorized file. Make a parameter edit only if the evidence connects it to the failure.

Return the complete replacement for `tuning.json` and a short reason, or no edits with the specific external condition that needs attention. The workflow repeats startup and measurement after a change.
