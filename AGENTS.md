# Development and collaboration guidelines

This file defines repository-wide development workflow, engineering conventions, and directory responsibilities; [docs/AGENTS.md](docs/AGENTS.md) defines documentation organization. Use the [Runtime implementation](src/runtime/) and [Policy compiler](src/runtime/compiler/) as the current architectural references. Record design goals separately from actual verification.

## Current directory responsibilities

| Location                                                      | Responsibility                                                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/contracts/`                                              | Public contract/operation definitions, JSON types, Recipe, and package exports                                       |
| `src/contracts/plugin-types/`                                 | Abstract plugin input/output types and their Schemas                                                               |
| `src/contracts/models/`                                       | Shared Candidate, file-tree, Measurement, metric, and evidence protocols                                            |
| `src/contracts/runtime/`                                      | Public RuntimeContext, service interfaces, execution scope, and events                                              |
| `src/contracts/policies/`                                     | Shared Policy input Schemas                                                                                        |
| `src/runtime/{registry,loaders,compiler,policy}/`             | Cordis registration, content loading and locking, the sole v1 DSL compiler, pure dataflow execution, and checkpoints |
| `src/runtime/{manager,services,revisions}/`                   | Sole ownership of facts and budgets, controlled calls and leases, revision acceptance/activation/recovery            |
| `src/runtime/storage/`                                        | Immutable artifacts, atomic facts/receipts, and local file storage implementations                                   |
| `src/plugins/shared/file-application/`                       | Target, editing, and sealing tools shared by file-based Applications                                                |
| `src/plugins/application-{agentbundle,inference}/`            | initialize/commit/acquire/release application lifecycle                                                              |
| `src/plugins/agent-pi/`                                       | Agent execution backend                                                                                              |
| `src/plugins/{proposer-agent,memory-agent,reflection-agent}/` | Application candidate proposals, experience consolidation, and general guidance revision proposals                   |
| `src/plugins/evaluator-{agentbench,inferencebench}/`         | Two SDK-backed evaluation plugins                                                                                   |
| `src/plugins/shared/evaluator-adapter/`                     | Shared Evaluator SDK execution, configuration/result mapping, metrics, and evidence adapters; not a public plugin    |
| `src/plugins/{selector-metrics,selector-artifacts}/`          | Metric selection and anonymous artifact selection                                                                    |
| `src/plugins/shared/agent-editing/`                           | Editing tools shared by business plugins; not registered as a separate public plugin                                 |
| `src/policies/`                                               | Complete Policies, their Reflection rules, and shared Prompts                                                        |
| `src/entries/{cli,web}/`, `web/`                              | rsi commands, Fastify entrypoint, React UI, and typed client                                                         |
| `src/shared/`                                                 | JSON, Schema, digest, and genuinely shared utilities                                                                 |
| `examples/harness/dsh-harness2/`                              | Recipe, Target, baseline, and documentation for the Harness² example                                    |
| `examples/harness/dsh-wikiskill/` | TerminalBench 4.0 WikiSkill Recipe, explicit task splits and skill-only DSH baseline |
| `examples/artifacts/`                                         | Artifact optimization examples                                                                                       |
| `tests/unit/`                                                 | Minimal behavior tests; run real evaluations separately and explicitly                                               |
| `scripts/`                                                    | Build, packaging, and independent consumption verification                                                           |
| `docs/`                                                       | Design, task, and experiment records                                                                                 |

Recipes and Policies use only `rsi.recipe/v1` and `rsi.policy/v1`; do not retain old parsers, Host/Profile, RolePlugin, or migration entrypoints. A regular plugin implements one public contract from src/contracts/plugin-types, defines one execute and owns its configuration Schema; input/output Schemas are declared only by that contract. Multiple lifecycle actions use an action-discriminated union. Policy require entries reference registered contract IDs; compile and load Policies with the Runtime registry. Startup code explicitly registers plugins and Policies; there is no separate Runtime configuration.

Applications manage optimization targets and instance lifecycles; Evaluators consume instances for measurement. The Manager owns candidates, measurements, budgets, and call receipts; Policies only orchestrate flows. Memory and Reflection are independent business plugins, while the Runtime owns structural acceptance and activation of Reflection revisions. The Web UI uses only public management/query interfaces and does not inject core state.

Keep all runtime data in the ignored `.rsi/` directory and one-off probes in `.scratch/` or a system temporary directory. `dist/` and `node_modules/` are generated artifacts. Source, builds, and release packages must not depend on examples; a file's presence alone does not enable it. New tests cover only necessary inputs/outputs, side effects, and failure/recovery boundaries; do not restore large suites tied to the shape of old implementations.

## Getting started

- Confirm the current branch, working tree, and relevant files first; preserve existing changes. Deliver one complete step within the current assignment and leave later design items for subsequent tasks.
- Before changing code, dependencies, tests, or engineering configuration, follow the [engineering conventions](#engineering-conventions) below. Read the [documentation guidelines](docs/AGENTS.md) before adding or changing documentation.
- Check relevant existing designs before implementing features or changing public interfaces, plugin responsibilities, or main flows. Create design documents only when the user explicitly requests design documentation; a new decision alone does not require a new document.
- Create task breakdowns and task records only when the user explicitly requests them. Do not create design or task documents for every request or change, or make them a prerequisite for editing code. When requested, follow the [documentation guidelines](docs/AGENTS.md) for record organization, naming, and content, and record actual results before delivery. Otherwise, explain relevant decisions and verification in the delivery response.
- Modify the root `README.md` only when the user explicitly requests it. Do not automatically add content or update it as part of development changes.
- Read root `AGENTS.local.md` when present for local supplements. Keep shared guidelines portable; do not record personal paths, secrets, or temporary branch state.

## Collaboration and delivery

- Use English by default for repository documentation, code comments, prompts, example prose, UI text, and repository metadata, including commit and PR descriptions. Match the user's language in conversation, including Chinese when the user writes Chinese. Preserve identifiers, commands, and quoted original errors.
- Lead with the result, followed by relevant changes, reasons, actual verification, and remaining limitations. Historical records establish only the version at that time; use current inspection for current conclusions.
- Use check entrypoints defined by existing repository configuration. Complete the verification appropriate to the change; for documentation-only changes, check content, links, and formatting.
- Before committing, pushing, merging, creating or updating a PR/Issue, publishing, or deleting a branch or workspace, confirm that the user explicitly authorized that action. Continue necessary steps that are already authorized; ask only when a key decision is missing.

## Engineering conventions

This section defines reusable engineering conventions. Check the current public contracts in [src/contracts](src/contracts/) and their implementations for plugin, interface, and algorithm behavior. Follow the [documentation guidelines](docs/AGENTS.md) for records.

### Code and directories

- Avoid overengineering. Implement the simplest solution that meets current requirements; do not add speculative abstractions, extension points, or infrastructure for hypothetical future needs.
- Use TypeScript and organize modules by responsibility. Keep role interfaces in their owning directories; extract cross-module types only when there is a real shared need. Package entrypoints export only what callers need.
- Give one module complete ownership of a behavior and split modules by independent reasons to change. New abstractions must correspond to current callers or replaceable implementations. Define shared fields, defaults, and serialization rules once in their owning module.
- Flow logic uses components through explicit interfaces; assembly entrypoints select concrete implementations. Module imports only define capabilities. Keep Cordis registration separate from execution, with runtime state owned by the corresponding instance.
- When a public interface changes, migrate callers, tests, and documentation together, then remove obsolete paths and duplicate definitions. Retain compatibility layers only for identified existing callers or data, with a stated scope and exit condition.
- Place files according to the [current directory responsibilities](#current-directory-responsibilities) above. New modules or directories must have real responsibilities and content.
- Use descriptive kebab-case file and directory names, `<topic>.test.ts` for tests, and optionally `.test.mjs` for directly executable JavaScript tests. Use camelCase for functions/variables and PascalCase for types/classes. Interface names express concepts without a mandatory I prefix.

### Types, interfaces, and exceptions

- Avoid excessive defensive programming. Validate external inputs and resource mutation boundaries, then trust validated internal contracts. Add guards, fallbacks, retries, and recovery logic only for concrete failure modes; do not duplicate validation or silently hide errors with defaults.
- Enable strict TypeScript checking and declare return types for exported functions and methods. Validate and narrow external JSON, configuration, files, and model output from `unknown` or explicit raw types; pass validated types internally.
- Do not bypass interface issues with `any`, double assertions, or suppressed diagnostics. If third-party declarations are genuinely defective, confine exceptions to the boundary and explain why. A type assertion is not runtime validation.
- Interfaces document inputs, results, errors, call order, and resource ownership. Comments explain necessary conditions and tradeoffs rather than repeating code line by line. Library boundaries return values or propagate errors rather than terminating the host process.
- Reject invalid configuration early with the specific field and reason. Distinguish success without changes, failure, cancellation, and unknown outcomes. Catch exceptions only where recovery, added context, or resource cleanup is possible.
- Treat model output as data awaiting validation. Programs enforce modification scope and actual write conditions. Internal protocols and default budgets belong to their owning modules and designs, not hardcoded general engineering guidelines.

### Asynchrony and side effects

- File handles, temporary directories, listeners, background tasks, and child processes need explicit owners and release paths covering success, failure, and cancellation.
- Set reasonable bounds on external requests and propagate cancellation. Give retries one owner and retry only explicitly retryable cases. Reconcile unknown write or publish outcomes before repeating side effects.
- Validate paths, scope, versions, and idempotency conditions at the resource mutation boundary. Identify who implements each external capability; a successful interface call does not prove that the host has used its result.
- Log only what is needed for diagnosis and redact sensitive configuration. Record known and unknown usage separately.

### Files and dependencies

- Root [.editorconfig](.editorconfig) and [.gitattributes](.gitattributes) define text formatting: UTF-8, LF, two-space indentation, and a final newline. TypeScript uses single quotes and semicolons; enforce these through actual formatting configuration once tooling is established.
- Preserve Markdown trailing spaces used for explicit line breaks. For fixtures with assertions about line endings, encoding, or raw bytes, set `-text` for explicit files or dedicated directories in `.gitattributes` and disable the corresponding automatic conversion in `.editorconfig` to avoid altering inputs.
- [.gitignore](.gitignore) excludes only identified local files and generated artifacts. Verify new rules with both paths that should be ignored and paths that should remain tracked. Keep source, lockfiles, declarations, fixtures, and formal records trackable.
- Keep secrets in local environment configuration; shared examples use placeholders only. Put personal conventions in `AGENTS.local.md`. Use local Git excludes or global ignores for personal editor preferences unless the team explicitly adopts that configuration.
- Add dependencies only when they reduce real maintenance costs, and declare runtime and development dependencies separately. Use pnpm for dependency management and scripts, with the version in root `package.json`'s `packageManager`. Maintain only `pnpm-lock.yaml` and update it with dependency changes. Install existing lockfiles with `pnpm install --frozen-lockfile`; add or upgrade dependencies with `pnpm add` / `pnpm update`. Module resolution and runtime requirements follow engineering configuration.

### Verification

- When establishing tooling, provide a unified check entrypoint combining type checks, builds, and unit tests; add formatting/static rules as maintenance requires. Commands follow the actual `package.json`, and CI reuses the same entrypoint. Do not describe nonexistent commands as available or passing.
- Default checks use deterministic inputs, temporary files, and local services without model credentials or real model requests. Provide a separate explicit entrypoint for integration tests and document environment requirements. Missing environments must not be reported as passing.
- Unit tests verify inputs, outputs, and side effects. Integration tests combine real modules and replace only external services or uncertain inputs. Add tests for behavior changes, reproduced defects, and key failure paths; avoid mirroring private implementation details.
- Changes to state or side effects must cover relevant failure, cancellation, repetition, and interruption cases. Verify only the concurrency assumptions involved. Tests create and clean up their own resources without relying on a developer's home directory or past run results.
- When changing package exports, runtime dependencies, or build rules, verify installation by an independent consumer so that success does not depend on the source checkout. Sanitize fixtures and make clear whether assertions establish a contract, loading, or effect.
- To claim Online Evolve has taken effect in a task, provide evidence of subsequent execution within the same unfinished task, separately confirming writing, loading, delivery, and actual use. If only component tests passed, report only that verification scope.
- For documentation-only or ignore-rule changes, check links, formatting, and positive/negative rule examples. Do not introduce runtime dependencies or unrelated test frameworks for them.

### Git commits

Authorization for commits, pushes, and publication follows [collaboration and delivery](#collaboration-and-delivery) above. Use a single-line commit title in the form `[type] Brief English description`:

| Type      | Purpose                      |
| --------- | ---------------------------- |
| `feature` | Add or change functionality  |
| `bug`     | Fix a defect                 |
| `docs`    | Documentation and guidelines |

Do not append `Author`, `Co-authored-by`, or other attribution paragraphs to commit descriptions. Include only files related to the current task.

## Documentation retention and append-only rules

- Retain designs in `docs/design/` only when their document date is no more than 14 days before the cleanup date, and task records in `docs/tasks/` for no more than 5 days, including the boundary date. Use document dates rather than modification times to avoid extending retention. For undated older files, use the date first tracked by Git.
- Group same-day documents under `docs/design/YYYY-MM-DD/` and `docs/tasks/YYYY-MM-DD/`. Keep separate files rather than combining unrelated topics. Name new files `YYYY-MM-DD-<topic>.md` or `YYYY-MM-DD-<type>-<topic>.md`, adding a same-day sequence when needed.
- Historical design/task documents are **append-only across new files, not revised in place**. When the user explicitly requests new design/task documentation, record later revisions, progress, acceptance results, and corrections in a new document dated today, referencing earlier documents and explaining what is supplemented or superseded. Otherwise, report these in the delivery response. Do not append new conclusions to earlier documents or revise their status or results. Records newly created during the current, undelivered task may be completed during that task.
- Apply these rules to retention cleanup, date-directory moves, and necessary link repairs without rewriting historical content. Remove expired documents from the working tree; Git retains their history. Use historical links to specific commits when references are still needed, without leaving broken local links.
- These rules replace earlier requirements to keep appending to an original design/task document. README files, navigation, AGENTS.md, and other entrypoints or rule files may be maintained to reflect the actual structure.

Organize plugin files around three responsibilities: `schema.ts` defines input, output, and configuration Schemas; `service.ts` implements business logic and lifecycles; `index.ts` assembles and exports the plugin definition. Do not register shared internal tools as public plugins. The Evaluator SDK is installed from a pinned commit of `https://github.com/evolving-foundry/ember-evaluator` under the dependency name `ember-evaluator`; the SDK owns its dependencies and prepare/build lifecycle.
