# Use an Agent sandbox

English | [简体中文](agent-sandbox_zh.md) · [Getting started](../getting-started.md)

Use `config.sandbox` to choose the filesystem write boundary for a native Agent call. RSI supplies settings for that call without changing host-wide user or system configuration.

## Supported scope

The explicit modes, `read-only` and `workspace-write`, currently support Linux with these backends:

| Backend     | Recipe `plugin`    | Prerequisites                                                                                                                                   |
| ----------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `agent.codex`      | An installed Codex CLI with compatible app-server configuration and native Linux sandbox capabilities.                                          |
| Claude Code | `agent.claudecode` | A compatible Claude Code CLI, `bubblewrap`, `socat`, and a Linux environment that permits the native sandbox to start.                          |
| DSH         | `agent.dsh`        | An installed `@deepseek-ai/dsh` CLI with its native base/headless, sandbox, filesystem and Shell components and full Linux sandbox enforcement. |

Install and configure model access for the selected CLI as described in [Configure experiments](configuration.md). Explicit modes fail when the platform or native capabilities are unsupported; RSI does not fall back to a less restrictive mode.

The setting applies to calls through the configured RSI Agent binding. If Proposer, Memory and Reflection share that binding, they share its sandbox setting. Evaluated Agents inside an Agent Bundle, Evaluators, Application lifecycle operations and remote services retain their own execution environments.

## Choose a mode

| Value             | Filesystem writes by enabled model tools and their confined child processes                               | Typical use                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `inherit`         | Use the backend's existing invocation behavior and effective native settings.                             | Keep an existing native setup, including capabilities excluded by the explicit modes.       |
| `read-only`       | Deny writes to ordinary files, including workspace and temporary files.                                   | Read inputs and return structured proposals without running tools that need writable files. |
| `workspace-write` | Allow writes within the current call's workspace and the temporary areas permitted by the native sandbox. | Run tools that need working files or temporary outputs.                                     |

Start with `read-only` for text inspection and structured proposals. Choose `workspace-write` when the enabled tools need to create files. `inherit` preserves native behavior, which can itself include a sandbox; it does not select a uniform RSI isolation level.

The workspace is the working directory supplied to the Agent for one call. It is often a prepared copy of task inputs. The Recipe directory and other host directories do not become extra writable roots automatically.

Candidate edits still pass through the structured proposal and Application validation flow. A `read-only` Agent can propose changes that RSI later applies outside that Agent call.

## Configure a Recipe or Policy

The examples below are fragments to merge into an existing Recipe or Policy. `agent` is an example binding name; use the Agent binding declared by your Policy and referenced by the calling components.

### Set the mode in a Recipe

```yaml
# Recipe fragment
bindings:
  agent:
    plugin: agent.codex
    config:
      sandbox: read-only
```

Use `agent.claudecode` or `agent.dsh` instead of `agent.codex` to select another supported backend. Set `config.executable` when the CLI is not available under its usual command name.

### Set a Policy default

```yaml
# Policy fragment
defaults:
  bindings:
    agent:
      plugin: agent.codex
      config:
        sandbox: workspace-write
```

For the same plugin, the Recipe's binding configuration overrides individual fields in the Policy default. Omitting `sandbox` from the Recipe keeps the Policy value. If the merged configuration has no `sandbox`, the backend uses `inherit` behavior.

To override the Policy's sandbox default explicitly:

```yaml
# Recipe fragment
bindings:
  agent:
    config:
      sandbox: inherit
```

Switching the binding's `plugin` discards the previous plugin's default configuration. Set `sandbox` explicitly for the new backend when switching plugins. See [Write a Policy](writing-policies.md) for binding declarations and defaults.

## Understand the boundary

| Area                      | Behavior in explicit modes                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tool file writes          | The selected mode governs direct writes from enabled tools and their confined child processes. Inherited extra writable roots are excluded.                                                            |
| File reads                | Read access follows the enabled tools and native backend rules. The modes do not define a common read-isolation policy.                                                                                |
| Network access            | Native network rules apply. `config.sandbox` provides no separate network-access option.                                                                                                               |
| Network or IPC services   | Writes performed by a service reached over a socket or network retain that service's permissions.                                                                                                      |
| RSI and trusted CLI state | RSI artifacts, call preparation and the trusted CLI's own session bookkeeping retain their existing owners. `read-only` describes model tool writes rather than every write made during an experiment. |
| Host configuration        | Restrictions are supplied through call-specific arguments, settings or private configuration directories. Enabling the mode does not rewrite host user or system configuration.                        |

Host executable extensions that cannot be kept inside the write boundary are excluded. All three backends currently disable subagent tools in explicit modes. Skill files supplied in the call workspace remain readable.

## Backend differences

### Codex

RSI uses Codex's native sandbox policy and per-process configuration overrides. Explicit modes disable inherited MCP servers, hooks, notification commands and executable extension features. The native patch and Shell tools operate under the selected boundary.

Codex runs with non-interactive approvals. A denied operation returns a tool error without an approval prompt. Native model and authentication settings continue to supply model access.

### Claude Code

The enabled filesystem and Shell tools depend on the mode:

| Mode              | Enabled tools                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `read-only`       | Glob and Grep. Bash, Read, Edit and Write are unavailable.                                 |
| `workspace-write` | Read, Glob, Grep and sandboxed Bash. Edit and Write are unavailable; file writes use Bash. |

The native Read tool can render PDFs into temporary files, so the read-only mode excludes it. Tools that require Shell execution or PDF reading need a compatible workflow and mode.

RSI uses a private Claude configuration directory and disables inherited hooks, MCP servers, plugins and executable authentication helpers such as `apiKeyHelper`. It carries supported model/provider environment settings and native OAuth credentials into the call. Use environment credentials or native OAuth when the usual setup depends on an executable helper.

### DSH

RSI uses a private native home and the installed base/headless components. It carries literal model/provider settings, environment configuration and native credentials into the call. Custom executable profile components are excluded; model/provider configuration containing executable expressions is rejected.

The filesystem and Shell services enforce the selected policy. Model tools expose Bash, read/search tools and Skills; direct Edit and Write tools are excluded, and permitted writes use Bash. RSI requires full native enforcement before submitting the task.

## Run and troubleshoot

After adding the setting to a complete Recipe:

```sh
arsi doctor path/to/recipe.yaml
arsi run path/to/recipe.yaml
```

When working from the source checkout, build first and replace `arsi` with `pnpm arsi`. Doctor can identify sandbox startup problems; model access still needs a working native CLI configuration. See [Doctor](doctor.md) for report interpretation.

| Symptom                                                  | Action                                                                                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sandbox preparation fails                                | Check Linux support, CLI compatibility and native sandbox dependencies. For Claude Code, check that `bubblewrap` and `socat` are available to the CLI.                                     |
| Authentication works normally but fails in explicit mode | Check whether it depends on an excluded executable extension. For Claude Code, use supported environment credentials or native OAuth; for DSH, use literal native model/provider settings. |
| A tool is unavailable                                    | Check the backend-specific tool list and the exclusions above. Claude Code read-only calls have no Bash or Read tool.                                                                      |
| A write is denied                                        | Check the mode and target path. `read-only` denies ordinary file writes; `workspace-write` permits only the call workspace and native temporary areas.                                     |

To verify the installed CLIs' boundaries from the source checkout, run the separate integration entrypoint:

```sh
pnpm test:integration:agent-sandbox
```

This requires Linux, installed project dependencies, all three native CLIs and their sandbox dependencies. The checks exercise native file and Shell effects with controlled files and local deterministic API fixtures. They do not run benchmarks or make external model requests. They are separate from the default unit suite.
