# Diagnose an experiment with doctor

English | [简体中文](doctor_zh.md) · [Getting started](../getting-started.md)

## 1. Purpose

`ember-rsi doctor` checks whether an experiment's configuration, inputs and supported runtime prerequisites are ready before you start it. Use it after preparing a Recipe, changing components, models or credentials, or moving an experiment to another environment.

```sh
ember-rsi doctor my-experiment/recipe.yaml
```

From a source checkout, build first with `pnpm build`, then use `pnpm ember-rsi doctor my-experiment/recipe.yaml`. Supply the environment variables required by the selected components; RSI does not automatically load `.env` files.

Doctor combines Recipe validation with component-specific checks. It can catch missing prompts or baselines, incompatible bindings, proposal model-access failures and SDK-reported evaluator configuration, runtime or download-route problems. Evaluator diagnostics come directly from the installed Evaluator SDK's doctor; RSI does not maintain a second set of evaluator probes.

Doctor does not run the optimization Policy, ask a model to answer a question or perform a real evaluation. The SDK's full evaluator doctor does perform temporary download and Docker build probes, and can acquire images; downloaded base images can remain cached. Its results establish only the facts checked at that moment, not task correctness, performance or optimization gains. `run` remains independent: it does not invoke doctor automatically or require a saved doctor report.

## 2. How it works

### Loading and dispatch

1. **Load registrations.** The CLI uses normal Runtime registration: built-in components, user extensions in `~/.ember-rsi/plugins/<name>/index.mjs`, and explicit `--plugin-dir` directories. An extension must export `register(registry)`.
2. **Load the effective Recipe.** `Recipe.load` validates Schemas, bindings, contract compatibility, Policy compilation, budgets and declared Reflection resources. Policy defaults and Recipe overrides are merged before probes run. A loading error produces a failed diagnostic and stops component probes.
3. **Check declared local paths.** For the Application, each effective binding and the configured Reflection implementation, doctor checks local file/directory fields marked with `x-rsi-path` for existence, type and readability. Relative paths follow the file declaring each configuration value. URL-like resources are not fetched.
4. **Run the matching bundled check.** Dispatch uses the concrete plugin implementation ID, such as `agent.pi`, rather than its public contract. Each binding receives its own results. Evaluator bindings prepare configuration through their normal RSI adapter, then invoke the installed SDK's public `doctor` CLI. RSI maps the returned diagnostics instead of probing Docker, disks or model services itself. Unavailable prerequisites leave dependent checks `unchecked`; independent checks can continue. An implementation without a bundled check receives an explicit `unchecked` entry.
5. **Clean up and report.** RSI checks use isolated temporary storage, propagate cancellation, release owned instances/processes and remove temporary files. Original artifacts may be read as inputs; RSI captures and writes stay in the temporary Runtime. The SDK owns its download/build probes and their cleanup; image caches can change. Doctor does not create an optimization run or record real Measurements in the experiment store.

Identified credentials and credential-bearing URLs are redacted from reported diagnostics.

### Time limits, timeouts and cancellation

Doctor checks bindings sequentially, with **no overall command deadline**. RSI's common checks and the delegated SDK doctor have separate timeout owners:

| Operation or check ID                   | Limit                                                          | Scope                                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Common `context.check` checks           | 60 seconds per check by default                                | Local paths, configuration and Application verification/acquisition have separate timers; operations within one check share its limit.                         |
| `agent.codex` `executable` and `doctor` | 60 seconds each                                                | CLI help and native doctor help share the `executable` timer; native JSON diagnostics are separate.                                                            |
| Pi `model-access` HTTP request          | 10 seconds per request                                         | Covers the HTTP request and complete response body within the outer 60-second check.                                                                           |
| Optuna `python-dependencies`            | 60 seconds outside; configured `python.timeoutMs` also applies | A shorter worker timeout can finish earlier; a longer value cannot extend the enclosing RSI check.                                                             |
| Evaluator SDK doctor                    | SDK-owned limits, not one enclosing RSI 60-second timer        | The pinned SDK gives CLI executable and Ray TCP/TLS checks 5 seconds, and each download/network probe up to 180 seconds. Multiple probes can run sequentially. |

Nested limits expire at the first deadline. For Pi, the request's 10 seconds are part of its 60-second check, not an extra allowance. The CLI has no doctor-specific timeout option, and these limits do not come from Recipe experiment budgets. Pi/Codex `config.timeoutMs` applies to real Agent execution; see [Configure Recipes, Targets and components](configuration.md).

An RSI check timeout produces `failed`, meaning the probe could not complete rather than establishing that the plugin is unavailable. The runner waits up to **15 additional seconds** for a cancelled common check to settle; otherwise it records an extra `<binding>.<check ID>.cleanup: failed`. Final Runtime and temporary-directory cleanup are outside that wait, so the command need not return within 60 or 75 seconds.

Evaluator cancellation is forwarded to the SDK invocation, allowing up to 60 seconds for native cancellation and cleanup before RSI forcibly terminates an unresponsive process tree. Forced termination cannot confirm cleanup of resources owned by the Docker daemon. The SDK controls its own probe timeouts and temporary-resource cleanup; its currently pinned network doctor allows 30 seconds to remove generated images. SDK timeouts and unsupported locations are reflected from its report. A whole SDK doctor can take longer than 60 seconds, and completed image downloads can remain in the cache.

### Reading the JSON report

Normal completion writes one JSON report to stdout, including configuration or registration failures:

| Field              | Meaning                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `recipeId`         | Loaded Recipe ID, or `null` if loading did not succeed.                                                    |
| `summary`          | Counts of `passed`, `failed` and `unchecked` checks.                                                       |
| `checks`           | Individual results with `id`, `status`, optional `binding`, `pluginId`, `reason` and `details`.            |
| `missingResources` | Missing input references, their configuration fields and kinds, and dependent check IDs that were not run. |

Component check IDs start with the binding name: a binding named `agent` using Pi produces `agent.model-config` and `agent.model-access`. A different name changes the prefix. `recipe.validate` is the Recipe-loading result.

| Status      | Interpretation                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `passed`    | This check established the fact described by its ID and explanation.                                                                                          |
| `failed`    | The check found an error or could not complete a required probe, for example rejected credentials or a request timeout. Read its explanation before retrying. |
| `unchecked` | The check could not establish a conclusion, for example because an earlier prerequisite failed or the selected execution path has no supported diagnostic.    |

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

All three Evaluators reuse the installed SDK's full doctor CLI. RSI prepares the SDK configuration through the same adapter used for evaluation, confines its configuration/output paths to the probe directory, and maps the SDK report. It does not retain separate Docker, disk, cache or evaluation-model probes.

| Implementation             | RSI configuration preparation                                                                                                    | SDK diagnostics and limits                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `evaluator.agentbench`     | Validate the Application/AgentBundle combination, bind the bundle directory, selected Policy task IDs and owned output location. | Delegate effective service, benchmark, environment and scheduler configuration to SDK doctor. No solver/verifier task is executed. |
| `evaluator.inferencebench` | Validate the inference Application combination and prepare the SDK configuration with an unstarted endpoint placeholder.         | Delegate SDK prerequisites and download/network checks. The real inference endpoint is not created or verified.                    |
| `evaluator.operatorbench`  | Load the operator task and prepare SDK assessment configuration using a selected case and owned manifest/output paths.           | Delegate SDK prerequisites and download/network checks. No kernel assessment or accelerator computation runs.                      |

For a binding named `evaluator`, the result IDs include:

| Check ID                                                   | Meaning                                                                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `evaluator.configuration`                                  | RSI adapter configuration preparation, including fields owned by the Application/RSI.                                                           |
| `evaluator.sdk-doctor`                                     | SDK invocation and report validation; successful transport is not proof that every SDK diagnostic passed.                                       |
| `evaluator.sdk.check-<index>`                              | An SDK prerequisite diagnostic, preserving its name and explanation. SDK `passed`/`failed` map directly, and `not-checked` maps to `unchecked`. |
| `evaluator.sdk.network`                                    | SDK network/download summary. SDK `incomplete` maps to `unchecked`; original probe results, evidence, routes and guidance remain in `details`.  |
| `evaluator.model-access`, `evaluator.docker-disk-capacity` | Agentbench explicitly records these as `unchecked` because the pinned SDK does not establish evaluator model-list access or disk capacity.      |
| `evaluator.inference-endpoint`                             | Inferencebench records `unchecked` because the Application creates the real endpoint only during an experiment.                                 |

The SDK's checks depend on the selected configuration: configuration and credential variables, Docker/Python availability, declared local dataset or bundle paths, Ray connection prerequisites and execution-node coverage. Its full network diagnosis performs actual temporary downloads; the Docker path also tests image acquisition and `FROM`/`RUN` builds. These are the SDK's probes, not RSI warmup or task execution. Downloaded base images may remain cached even after generated probe resources are cleaned.

The currently pinned SDK doctor does **not** query evaluator model lists, measure remaining daemon disk space, compare incremental storage demand, enumerate cached task metadata or verify every task image cache. RSI does not infer those conclusions from a successful SDK report. The SDK explicitly leaves model/task execution and unsupported execution-node readiness unchecked. Missing input or credential configuration can prevent doctor from producing a report and is surfaced as a failed SDK invocation.

SDK CLI exit `1` can accompany failed diagnostics or incomplete network coverage. RSI uses the returned statuses, rather than converting every such exit into a failure: a report containing only unchecked diagnostics can still produce RSI exit `0`.

### Proposal model access

Pi requests `GET <base_url>/models` from the RSI process, using its own effective model, address and credential. The check passes only for HTTP `200`, a valid JSON `data` array of model objects with nonempty string IDs, and an exact configured-model ID match. Authentication rejection, missing models, invalid replies, timeout and network failure have separate explanations. No model answer is requested.

For Codex, native health and provider reachability are reported separately from model availability. A successful native health report does not establish model-list membership. Neither Pi nor Codex proposal health establishes evaluator model access; that remains outside the current SDK doctor's coverage.

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
3. Keep temporary writes in `context.directory` or its isolated Runtime, propagate the check's cancellation signal and clean up on success, failure and interruption. Do not execute an Agent, Policy or real evaluation; describe any download/build side effects explicitly and keep evaluator diagnostics delegated to the SDK.
4. Add behavior, failure and relevant cancellation/cleanup tests, register the probe in the bundled implementation-ID map, and rebuild. Update this coverage guide with the actual scope and limitations.

The existing [doctor tests](../../../tests/unit/doctor.test.ts) and [evaluator tests](../../../tests/unit/doctor-evaluators.test.ts) demonstrate result aggregation, prerequisite handling, cancellation and cleanup.
