# DSH WikiSkill on Terminal-Bench 4.0

The baseline Bundle starts with an empty prompt and no skills.

This example uses ten distinct, explicit Terminal-Bench 4.0 task IDs: six for training, two for validation and two for final independent testing. Edit the three task ID lists in recipe.yaml to change the split. WikiSkill checks for duplicates across the lists before evaluation. Repeated rounds evaluate the same selected tasks; ten is the number of distinct tasks, not the number of task attempts.

Task IDs follow the task.name values at the [Evaluator profile's pinned source commit](https://github.com/harbor-framework/terminal-bench/tree/452bf305c6daa62fc59061d22133a7cbc7c1572e/tasks). The split is a small workflow example, not a representative random sample.

Each of three rounds evaluates the incumbent on training tasks, updates Wiki memory from training scores and execution evidence, proposes one skill change, and gates that candidate on the same validation tasks. Ties retain the incumbent. Only the selected final candidate is evaluated on the independent test split after learning finishes; the Policy does not feed that result into learning steps. Runtime does not enforce task-ID-based evidence restrictions. This is a small workflow example, not a representative benchmark estimate.

The Target permits changes only to skill Markdown. The Bundle's base instructions, loader and metadata remain protected. Agent and Memory use the WikiSkill Policy defaults. The Recipe supplies the benchmark-dependent evaluator binding. The success-rate metric selector is a WikiSkill Policy default; override its Recipe binding only when a different selection rule is needed. WikiSkill has Memory; its current Policy does not run Harness² component Reflection.

Prepare Node 24, project dependencies, DSH/AgentBundle, a working Docker Engine and access to the task archive/images. The official Terminal-Bench 4.0 images use linux/amd64; ARM64 hosts need working emulation. The selected task metadata request up to 8 CPUs and 8 GiB RAM per task; configure the Docker VM accordingly. Set MODEL_NAME, MODEL_ENDPOINT and MODEL_API_KEY in the same shell. Evaluation provisions the candidate through AgentBundle. The Recipe retains its 3,600-second evaluator task timeout and 48-hour experiment wall budget. Pi uses a 30-minute request timeout and 60-minute execution timeout. Model-call and output-token ceilings are omitted, while native task limits may stop a task earlier. There are eight evaluation runs (baseline, training/validation for three rounds, final test), executing 28 task attempts before infrastructure retries.

From the repository root:

```bash
ember-rsi doctor examples/harness/dsh-wikiskill/recipe.yaml
ember-rsi run examples/harness/dsh-wikiskill/recipe.yaml
```

Inspect `.rsi/` for call receipts, checkpoints, candidates, measurements and Wiki Memory artifacts. Runtime data are ignored by Git. Creating/validating this Recipe does not execute the ten-task experiment.
