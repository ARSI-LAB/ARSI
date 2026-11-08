# Restore the inference baseline

Read the last trial failure in `context/input.json` and inspect the candidate parameter file. Propose the smallest supported change that can bring the same model and service to readiness. Preserve the workload, model, deployment, engine version, and evaluation conditions. Avoid changing launch topology or adding undocumented flags. Return only an edit to the permitted parameter file, or no edits if the failure requires an infrastructure fix. The workflow owns startup and benchmark validation.
