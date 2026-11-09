# Agent-driven vLLM parameter tuning

The [`parameter-agent` Recipe](recipe.yaml) measures a vLLM Ascend baseline with
AISBench. An agent proposes serving parameter changes, and RSI tests them on
the same workload to select a configuration based on throughput and latency.

## Usage

1. Install the `ember-rsi` CLI and companion skill by following the
   [repository README](../../../../README.md#installation).
2. Give your coding agent the instruction below.

```text
Use the ember-rsi skill to start a vLLM inference parameter optimization experiment.

1. Goal. Maximize output throughput (tokens/s) while meeting my P90 TTFT and
   P90 TPOT limits. Ask me for both limits in milliseconds and the run budget
   if I haven't provided them.

2. Prepare the experiment. Copy examples/artifacts/inference/parameter-agent
   and adapt the Recipe and its assets to my setup.

   - Baseline. Ask me for a known-working vLLM launch configuration. Put its
     tunable parameters in baseline/tuning.json and keep fixed settings,
     such as the model and device assignment, in the deployment script.
   - Server. Ask for the serving and benchmark host details, including SSH
     access. Try connecting and check the vLLM environment, model and devices.
   - Evaluation. Ask for the workload, including concurrency, request rate,
     request count, and input/output lengths. Over SSH, check the AISBench
     Python executable, installation path and version, writable work directory,
     and tokenizer path. Fill in the evaluator configuration. Set the selector
     metric to outputThroughput and set the ttftP90 and tpotP90 limits. Update
     the copied tuning prompt and skill to match the experiment settings.
   - Deployment. Use examples/artifacts/inference/shared/scripts/remote-vllm.py
     as a template. Implement start, status, stop, and describe_parameters.
     Launch the baseline, verify readiness, run a short AISBench test, and
     confirm cleanup. Set the serving endpoint in the Recipe and point
     application.config.remote.script to the verified deployment script.

3. Run and monitor. Validate the prepared Recipe with ember-rsi validate and
   start it with ember-rsi run <recipe.yaml> --id <experiment-id>. Keep the
   run active and check ember-rsi show <experiment-id> from another terminal
   in the same working directory until it finishes. Report the baseline and
   best measured throughput, TTFT, and TPOT, and say whether both limits were met.
```
