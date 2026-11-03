# Recipes, Target and baseline

Use the complete [recipe](../assets/minimal/recipe.yaml), [Target](../assets/minimal/target.yaml) and [baseline manifest](../assets/minimal/baseline/bundle.yaml). All referenced resources are included in this skill.

| Recipe field      | Shape                                                                       |
| ----------------- | --------------------------------------------------------------------------- |
| schemaVersion, id | `rsi.recipe/v1`, nonempty identity                                          |
| application       | `{ ref, config }`                                                           |
| policy            | `{ ref, config, input }`                                                    |
| bindings          | Binding name → `{ ref, config, bindings? }`                                 |
| budget            | Numeric usage limits and durations                                          |
| reflection        | Optional `{ configFile: ./reflection.yaml }`; omit when no module is needed |

`reflection: false`, `{ ref: ... }` and old rule files are unsupported. Omission inherits a Policy's `defaults.reflection.configFile` when present; it does not disable an inherited module. Use a Policy without the module/call when disabling it.

Same-ref overrides merge config **one property level deep**; replacing a nested property replaces that object. Changing ref replaces the implementation configuration. Child bindings merge by child key. Keep `policy.config` (algorithm parameters), `policy.input` (call input) and binding config (implementation settings) distinct. Use [public schema lookup](plugins.md#discover-schemas-through-public-apis) when adapting a binding.

## Target

`application.agentbundle.config` requires `target: { schema: path-or-object }` and exactly one of `baseline: { directory: path }` or `{ artifactRef: ref }`.

Target requires `schemaVersion: rsi.target/v1`, nonempty `id`, nonempty `entries`. Each entry requires `path`, `kind: file|directory`, nonempty `description`, and nonempty unique `changes` from `create`, `modify`, `delete`. Paths are normalized relative paths without `..` or symlinks. A file entry must already exist in baseline. For new files, use a directory entry with create permission, for example:

```yaml
- path: skills
  kind: directory
  description: Editable markdown skills
  changes: [create, modify, delete]
  include: ['**/*.md']
  content: { encoding: utf-8, minBytes: 1, maxBytes: 8192 }
```

This is an entry fragment inside `entries`. Optional `protected` globs prohibit changes even within an allowed entry. Optional `constraints` contains `maxChangedFiles` and `maxChangedBytes`. Per-call `editConstraints` can further narrow scope. New files must have mode 0644; mode changes and special files are rejected. The Application validates and seals edits after proposal.

## AgentBundle

The supplied baseline is complete: numeric `schemaVersion: 1`, `kind: dsh-agent-bundle`, harness name/version range, a **nonempty** list of local plugin paths, entry YAML and dependency lockfile. Each plugin includes package metadata, JS entry and Cordis patch. `prompt.md` is candidate content; the plugin loads it into DSH's system prompt. Protect structural files when optimizing only prompts. An arbitrary directory or a lone prompt is not an AgentBundle.

## Paths, models and budgets

Fields annotated `x-rsi-path: file|directory` resolve relative to their declaring Recipe or Policy file; names alone do not confer path behavior. Overrides retain origin per top-level property. Copy resources together and stay inside the host's resource bases.

`agent.pi` config uses `model`, `base_url`, `api_key`; the key must be an environment reference such as `${MODEL_API_KEY}`, never a literal secret. `${MODEL_NAME}` differs from Policy `${{ config.name }}` expressions. Not every string supports environment substitution. See the complete [learning recipe](../assets/learning/learning-recipe.yaml).

Set explicit `modelCalls`, `evaluationRuns`, `operations`, `elapsedWallMs`, `cleanupReserveMs`. Counts may be zero; durations are milliseconds and positive. Omitted limits are not zero. Include baseline, nested calls and learning calls; rounds are not operation counts. `validate` checks schemas and wiring, not bundle initialization, credentials, hardware or execution success.
