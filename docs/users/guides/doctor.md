# Diagnose an experiment with doctor

English | [简体中文](doctor_zh.md) · [Getting started](../getting-started.md)

## 1. Purpose

`ember-rsi doctor` checks whether an experiment's configuration, inputs and supported runtime prerequisites are ready before you start it. Use it after preparing a Recipe, changing components, models or credentials, or moving an experiment to another environment.

```sh
ember-rsi doctor my-experiment/recipe.yaml
```

From a source checkout, build first with `pnpm build`, then use `pnpm ember-rsi doctor my-experiment/recipe.yaml`. Supply the environment variables required by the selected components; RSI does not automatically load `.env` files.

Doctor combines Recipe validation with component-specific probes. It can catch missing prompts or baselines, incompatible bindings, missing cached images, proven disk shortages, and model services that reject the credentials used by one side of an experiment. Proposal access and evaluation access are checked separately because they can run in different places with different credentials.

Doctor does not run the optimization Policy, ask a model to answer a question, perform a real evaluation, or fetch missing datasets and images. Its results establish the facts checked at that moment; they do not establish task correctness, performance or optimization gains. `run` remains independent: it does not invoke doctor automatically or require a saved doctor report.

## 2. How it works

### Loading and dispatch

1. **Load registrations.** The CLI uses normal Runtime registration: built-in components, user extensions in `~/.ember-rsi/plugins/<name>/index.mjs`, and explicit `--plugin-dir` directories. An extension must export `register(registry)`.
2. **Load the effective Recipe.** `Recipe.load` validates Schemas, bindings, contract compatibility, Policy compilation, budgets and declared Reflection resources. Policy defaults and Recipe overrides are merged before probes run. A loading error produces a failed diagnostic and stops component probes.
3. **Check declared local paths.** For the Application, each effective binding and the configured Reflection implementation, doctor checks local file/directory fields marked with `x-rsi-path` for existence, type and readability. Relative paths follow the file declaring each configuration value. URL-like resources are not fetched.
4. **Run the matching bundled probe.** Dispatch uses the concrete plugin implementation ID, such as `agent.pi`, rather than its public contract. Each binding receives its own results. Unavailable prerequisites leave dependent checks `unchecked`; independent checks can continue. An implementation without a bundled probe receives an explicit `unchecked` entry.
5. **Clean up and report.** Bundled probes use isolated temporary storage, propagate cancellation, release owned instances/processes/containers, and remove temporary files. Original artifacts may be read as inputs; probe captures and writes stay in the temporary Runtime. Doctor does not create an optimization run or record real Measurements in the experiment store.

Identified credentials and credential-bearing URLs are redacted from reported diagnostics.

### Time limits, timeouts and cancellation

Doctor checks bindings and operations sequentially, with **no overall command deadline**. The table lists the current bundled limits; check IDs omit the binding prefix. Runtime registration, Recipe loading and final Runtime/temporary-directory cleanup are outside the common per-check timer, so the largest table entry is not an upper bound on total command duration.

| Operation or check ID                                                              | Limit                                                                      | Scope                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Common `context.check` checks                                                      | 60 seconds per check by default                                            | Local-path, configuration and Application verification/acquisition checks have separate timers. Operations within one check, such as acquiring, reading and releasing an instance, share its limit. |
| `agent.codex` `executable` and `doctor`                                            | 60 seconds each                                                            | CLI help and native doctor help share the `executable` timer; native JSON diagnostics are a separate check.                                                                                         |
| Agentbench `task-metadata`                                                         | 60 seconds                                                                 | Enumeration, preparation and ID validation for all selected local/cached tasks combined, not 60 seconds per task.                                                                                   |
| Model-list requests inside Pi `model-access` and Agentbench `gateway-model-access` | 10 seconds per request                                                     | Covers the HTTP request through reading the complete response body. The enclosing check still has its 60-second limit.                                                                              |
| Agentbench `task-image-<index>` and `gateway-image-cache`                          | 15 seconds per image                                                       | Each `docker image inspect` has its own timer, rather than sharing 15 seconds across all images.                                                                                                    |
| Agentbench `docker-disk-space` measurement phase                                   | 60 seconds shared across the phase                                         | Helper image/platform checks and all filesystem measurements share one cancellation signal; the timer does not restart per filesystem.                                                              |
| Agentbench `docker-disk-capacity` image-inventory phase                            | 60 seconds shared across the phase                                         | Separate from the preceding disk measurement. Cached image/layer metadata inspection for the target platform shares this limit, rather than receiving 60 seconds per image.                         |
| Optuna `python-dependencies`                                                       | 60 seconds outside; the worker also observes configured `python.timeoutMs` | With no worker timeout, the enclosing check supplies the limit. A shorter worker timeout can terminate it earlier; a longer value cannot extend doctor's 60-second limit.                           |

Nested limits take effect when the first expires. For example, gateway container startup, the model request and normal cleanup share the outer 60 seconds. The request's own 10 seconds are inside that limit, not an additional allowance totaling 70 seconds. The CLI has no doctor-specific timeout option, and these limits do not come from the Recipe's experiment budget. Pi/Codex `config.timeoutMs` applies to real Agent execution and does not change these doctor limits; see [Configure Recipes, Targets and components](configuration.md) for actual experiment settings.

A timeout in a common check, model request, image-cache inspection or disk measurement makes the corresponding check `failed`. This means the probe could not complete, rather than establishing that the plugin is unavailable. Dependents remain `unchecked` according to their prerequisite rules; independent checks can continue. An image-inventory timeout instead leaves unavailable disk-demand facts unknown, usually keeping capacity `unchecked`; an already proven storage shortage still produces `failed`.

After `context.check` is cancelled by its deadline or command interruption, the runner waits up to **15 additional seconds** for that operation to settle and execute its own `finally` blocks. If it does not settle, an extra `<binding>.<check ID>.cleanup: failed` records that cleanup could not be confirmed. Errors during cleanup are retained in diagnostics. The common command runner terminates its owned process tree on cancellation and waits for exit.

Each `docker rm -f` for mount, gateway-model and disk helper containers has a separate **10-second** limit with a signal independent of the original check, allowing cleanup after timeout or interruption. This can overlap the 15-second settling wait; the limits are not simply additive. Final Runtime and temporary-directory cleanup are also outside that 15-second wait. A default 60-second check therefore does not promise that the command returns within 60 or 75 seconds.

### Reading the JSON report

Normal completion writes one JSON report to stdout, including configuration or registration failures:

| Field              | Meaning                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `recipeId`         | Loaded Recipe ID, or `null` if loading did not succeed.                                                    |
| `summary`          | Counts of `passed`, `failed` and `unchecked` checks.                                                       |
| `checks`           | Individual results with `id`, `status`, optional `binding`, `pluginId`, `reason` and `details`.            |
| `missingResources` | Missing input references, their configuration fields and kinds, and dependent check IDs that were not run. |

Component check IDs start with the binding name: a binding named `agent` using Pi produces `agent.model-config` and `agent.model-access`. A different name changes the prefix. `recipe.validate` is the Recipe-loading result.

| Status      | Interpretation                                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passed`    | This check established the fact described by its ID and explanation.                                                                                                 |
| `failed`    | The check found an error or could not complete a required probe, for example rejected credentials or a request timeout. Read its explanation before retrying.        |
| `unchecked` | The check could not establish a conclusion, for example because an image is not cached, an earlier prerequisite failed, or the selected execution path has no probe. |

Exit code `1` means at least one check failed; `0` means no check failed, **including reports with unchecked entries**. Interruption returns `130`; command usage errors, such as omitting the Recipe argument, return `2`. These latter cases do not promise a completed JSON report. Review unchecked results even when the exit code is zero.

## 3. Checks for built-in components

The bundled map covers the following 17 implementations. Only components present in the effective Recipe are probed. Every row also receives the common registration, configuration, contract and declared-path checks described above. Check IDs in the tables omit the binding prefix.

### Applications and Agents

| Implementation            | Checks performed                                                                                                                                                                                                                                                 | What remains outside the check                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `application.agentbundle` | `baseline`, `verify-bundle`, `acquire-instance`, `cleanup`: read Target and baseline directory/artifact, validate required files and bundle contents through real initialization, acquire a temporary instance, read its bundle, release it and confirm release. | Does not execute the harness Agent or evaluate the bundle.                                                                                             |
| `application.kernel`      | `baseline`, `verify-source`, `acquire-instance`, `cleanup`: read Target and baseline, validate kernel source structure, acquire/read/release a temporary source instance.                                                                                        | Does not execute Python, compile a kernel, or check correctness or speed.                                                                              |
| `application.inference`   | `baseline`, `launch-prerequisites`: check local launch command, working directory and resource paths; or the remote controller's interpreter, script and parameter JSON; check configured credential environment references and plugin construction.             | Does not start/acquire an inference service or verify the remote machine.                                                                              |
| `agent.pi`                | `model-config`: resolve its own model/address/key references, validate URL and token limits; `model-access`: query the model list from the RSI process where Pi runs.                                                                                            | No inference request; successful discovery does not prove generation permissions or model behavior.                                                    |
| `agent.codex`             | `executable`: locate the configured CLI and inspect supported commands; `doctor`: invoke native JSON diagnostics, using `--network-only` when supported, its own authentication, configured model/thinking level and an isolated managed project.                | `model-access` stays `unchecked`: native health does not establish model-list membership. Unsupported native doctor versions are explicitly unchecked. |

### Proposers, Memory, Reflection, Selectors and Search

| Implementation            | Checks performed                                                                                                                                                                                                                    | What remains outside the check                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `proposer.agent`          | `agent-binding`, `editing-inputs`, `prepare-project`: validate the Agent reference/contract, read prompt/guidance, skills and configured role prompts, and assemble an isolated editing project.                                    | Does not generate or commit a proposal.                                                |
| `proposer.operator`       | `agent-binding`, `operator-task`, `operator-resources`, optional `hardware-context`: load task files, validate task/case identities, read stage prompts, explicit knowledge and retrieval resources, and optional hardware context. | Does not run retrieval, call a model, execute a kernel or probe accelerator hardware.  |
| `proposer.grid`           | `configuration`: construct/dispose the plugin, validating parameter path, axis names and grid cardinality.                                                                                                                          | Does not enumerate proposals or commit candidates.                                     |
| `proposer.optuna`         | `python-dependencies`: run the Python worker's dependency-check action with the configured sampler, search space and constraint handling; validate its dependency/version response.                                                 | Does not optimize or request a parameter suggestion.                                   |
| `memory.agent`            | `agent-binding`, `editing-inputs`, `prepare-project`: check the Agent and prepare the configured prompt, guidance, skills and roles in an isolated project.                                                                         | Does not consolidate experience or establish a Memory benefit.                         |
| `reflection.agent`        | `agent-binding`, `editing-inputs`, `prepare-project`: check the Agent, configured editing inputs and bundled reviewer, and prepare the isolated project.                                                                            | Does not propose, accept or activate a Reflection revision.                            |
| `selector.metric`         | `configuration`: construct/dispose the plugin, including eligibility and constraint bound validation.                                                                                                                               | Does not compare real Measurements or prove that a configured metric will be produced. |
| `selector.artifact`       | `agent-binding`, `editing-inputs`, `prepare-project`: check the Agent and prepare selection prompts, guidance, skills and roles.                                                                                                    | Does not ask an Agent to select an artifact.                                           |
| `search.prompt-evolution` | `modules`, `baseline-modules`: validate module definitions and confirm declared module files exist in the local baseline or file-tree artifact.                                                                                     | Does not run GEPA search, edit modules or evaluate their scores.                       |

### Evaluators

| Implementation             | Checks performed                                                                                                                                                                                                                                      | What remains outside the check                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evaluator.agentbench`     | `configuration`, `sdk-configuration`, `services`; cache-only task metadata, selected task IDs, Docker CPU/memory, cached images, disk observations/capacity, read-only mounts and selected solver model access where supported. Details follow below. | Does not pull/build images, download tasks, run the solver/verifier or perform an evaluation. Other execution paths and unavailable cache prerequisites remain unchecked. |
| `evaluator.inferencebench` | `configuration`, `sdk-configuration`: validate Application compatibility and assemble/load effective SDK configuration using a placeholder endpoint.                                                                                                  | `inference-endpoint` is `unchecked` because the Application creates it during a real experiment; no service is launched or queried.                                       |
| `evaluator.operatorbench`  | `operator-task`, `sdk-configuration`: read `task.json`, `problem.py` and `test.py`, validate task/case identities, and validate SDK assessment configuration using the first case.                                                                    | Does not execute an operator assessment or establish accelerator, driver or evaluation dependency readiness.                                                              |

Agentbench's detailed runtime probes apply to the SDK's local Docker execution path. Selecting a remote Docker daemon still probes that daemon; an SDK deployment to another execution node is not covered by these local coordinator checks.

| Check IDs                                                      | What they establish and when they remain unchecked                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services`                                                     | Resolve all declared service model/address references and the credentials required by the selected solver/verifier. This is configuration validation, not a network test of every service.                                                                                                                |
| `dataset-source` / `dataset-cache-inspection`, `task-metadata` | Inspect a supported local Harbor task source or existing cache, read task metadata and validate selected IDs. Registry discovery, missing caches, unsupported benchmark probes or relative per-evaluation locations can leave metadata unchecked; no dataset is downloaded.                               |
| `docker`, `docker-capacity`                                    | Read `NCPU` and `MemTotal` from the selected daemon and compare CPU/memory with available task declarations. Missing task metadata prevents the comparison.                                                                                                                                               |
| `task-image-<index>`, `task-builds`, `gateway-image-cache`     | Inspect solve, verify, auxiliary-service and gateway image caches. Required builds remain unchecked. Missing cached images are reported as missing resources with dependent checks; doctor does not fetch them.                                                                                           |
| `workspace-cache-mounts`                                       | Use the cached gateway image to read an owned marker and the available dataset through read-only mounts. No supported local dataset, missing helper image or unestablished local layer content prevents the active probe.                                                                                 |
| `docker-disk-space`, `docker-disk-capacity`                    | Measure supported filesystems on the daemon node and compare known incremental demand; see the disk rules below.                                                                                                                                                                                          |
| `gateway-model-access`                                         | Query only the selected solver service from a cached gateway-image container, using effective SDK model/address, that service's key and the SDK runtime proxy settings. Missing prerequisites or unsupported execution paths remain unchecked; verifier/judge services have no separate model-list probe. |

### Model access rules

Pi and the supported Agentbench gateway request `GET <base_url>/models`, each from its own execution location with its own credential. Evaluator loopback addresses use `host.docker.internal`, matching the SDK gateway; its runtime proxy route is kept separate from the RSI host's route.

The model-list check passes only when the service returns HTTP `200`, the JSON contains a valid `data` array of model objects with nonempty string IDs, and an ID exactly matches the configured model. Authentication rejection, an absent model, an invalid reply, timeout and network failure produce separate explanations pointing to the relevant side's key, model name, address or network. A successful proposal check does not imply that evaluation can connect.

For Codex, native health and provider reachability are reported separately from model availability. The bundled integration does not treat a successful native health report as evidence that `/models` contains the configured model.

### Disk rules

Disk availability is measured on the selected Docker daemon node, including a Docker Desktop VM or remote Docker host. The terminal's disk is not a substitute. [`docker system df`](https://docs.docker.com/reference/cli/docker/system/df/) reports used/reclaimable space, not remaining filesystem capacity; [containerd storage can also be separate from DockerRootDir](https://docs.docker.com/engine/storage/containerd/#disk-space-usage).

The capacity calculation distinguishes image pull, unpack, SDK-derived builds and declared task runtime storage, and deduplicates cached image/layer identities by target platform. A cached image's aggregate `Size` is not charged again as incremental demand. Missing sizes and unresolved storage locations remain unknown in `details`, with unknown byte quantities represented by `null`. The largest effective `resources.storage` declaration is a known lower bound, not an enforced quota or the peak across concurrent work.

A proven shortfall or daemon `ENOSPC` is `failed`, retaining measured availability, known demand and any computable deficit. Otherwise, missing unpack/build/runtime demand or an unresolved content-store location keeps capacity `unchecked`. A disk-space observation can pass while the capacity conclusion remains unchecked. Active helpers use cached images without network access; lazy or unrecognized snapshotters that cannot establish local layer content prevent helper startup.

## 4. Connecting custom components

### Automatic checks through normal registration

Register a custom component normally and select it in the Recipe or Policy. It automatically receives registration, configuration Schema, binding/contract and declared local-path checks. See [Write a plugin](writing-plugins.md) for complete plugin and Policy examples.

Mark local inputs in the component's `configSchema`:

```ts
export const configSchema = {
  type: 'object',
  properties: {
    inputFile: { type: 'string', 'x-rsi-path': 'file' },
    assets: { type: 'string', 'x-rsi-path': 'directory' },
  },
  required: ['inputFile'],
  additionalProperties: false,
};
```

After building the plugin, register its definition in the extension directory's `index.mjs`:

```js
import { customDefinition } from './dist/index.js';

export function register(registry) {
  registry.registerOperation(customDefinition);
}
```

Run doctor with the same extension that `run` will load:

```sh
ember-rsi doctor my-experiment/recipe.yaml --plugin-dir ./my-extension
```

For a binding named `custom`, the example produces `custom.resource.inputFile` and, when supplied, `custom.resource.assets`. Schema-marked relative paths follow their declaring file. Unmarked strings are not inferred to be paths; URL-like values are skipped rather than fetched. Generic path checks do not expand `${ENV}` references, so supply concrete paths for these checks. Environment-reference resolution belongs to the component's own implementation/probe, not to JSON Schema string validation.

### Current limit: no public custom-probe hook

When no bundled probe exists for its implementation ID, the component receives `custom.plugin: unchecked`. Its `create` and `execute` are not called by doctor, so additional validation inside `create` does not run. Sharing a public contract with a built-in implementation does not inherit that implementation's probe.

The current plugin definition has no `doctor` or `check` field; adding one is rejected by Registry. There is no public `registerDoctor` API, doctor-specific CLI probe-loading option or exported `DoctorScript`/`DoctorContext` API. The runner's internal `scripts` option is a test seam, not an installed-extension mechanism. Custom components can therefore integrate with the automatic checks above, but cannot currently attach additional business probes through ordinary extension registration.

### Adding a bundled probe in RSI source

This requires a framework source change and a rebuilt CLI:

1. Implement an internal [DoctorScript](../../../src/runtime/doctor/types.ts) for the concrete plugin ID, organized with the relevant [bundled checks](../../../src/runtime/doctor/scripts.ts).
2. Record bounded operations through `context.check`; use `context.unchecked` for unsupported or unavailable prerequisites and `context.missing` for missing inputs and dependent checks. The runner adds the binding prefix, redacts results and aggregates counts.
3. Keep temporary writes in `context.directory` or its isolated Runtime, propagate the check's cancellation signal and clean up on success, failure and interruption. Do not execute an Agent, Policy or real evaluation, or fetch/build missing resources.
4. Add behavior, failure and relevant cancellation/cleanup tests, register the probe in the bundled implementation-ID map, and rebuild. Update this coverage guide with the actual scope and limitations.

The existing [doctor tests](../../../tests/unit/doctor.test.ts) and [evaluator tests](../../../tests/unit/doctor-evaluators.test.ts) demonstrate result aggregation, prerequisite handling, cancellation and cleanup.
