# Use skills

English | [简体中文](using-skills_zh.md) · [Getting started](../getting-started.md)

This guide covers three ways to provide skills: to a coding Agent, to the evaluated Agent, and to optimization plugins.

## Give a coding Agent the RSI skill

The RSI skill guides a coding Agent through writing Recipes, validating configuration, and troubleshooting experiments.

1. Place the complete [RSI skill directory](../../../skills/ember-rsi/SKILL.md) in a skill location supported by your Agent, keeping `SKILL.md` and its sibling `references/` and `assets/` directories.
2. Ask the Agent to read the skill, then give it a concrete task, such as “Write a Recipe for this project and validate it.” You can also give the Agent the path to `SKILL.md` directly.

## Add a skill to the evaluated Agent

These skills are provided with the Baseline Agent Bundle and read by its Agent plugin to guide the evaluated Agent's task execution.

1. Prepare a directory containing `SKILL.md`. Its `name` identifies the skill, `description` explains its purpose, and the body contains the instructions. For example:

   ```markdown
   ---
   name: output-checks
   description: Check task outputs before finishing.
   ---

   Before finishing, verify that the requested files exist and report any missing outputs.
   ```

2. Place the directory where the Agent plugin expects it within the Baseline. The plugin reads the file and adds its contents to the Agent's prompt or context; custom Agent plugins must implement this logic.
3. To let the optimization flow create or edit these skills, include their paths in the permitted [Target](../getting-started.md#target) scope.

## Configure skills for optimization plugins

`proposer.agent` copies the locked skill directories into `.agents/skills/` in the workspace for the current call. Pi and Codex discover the skills and read their instructions and references as needed.

1. Prepare a skill directory, such as `my-experiment/skills/code-editing/SKILL.md`.
2. Add `skills` to an existing plugin binding's configuration in the Recipe:

   ```yaml
   # Recipe excerpt
   bindings:
     proposer:
       config:
         skills:
           - ./skills/code-editing
   ```

### Configure specialist agents

Set `subagents` in the same `proposer.agent` binding. RSI locks role prompts and skills with the Recipe. Parent and child sessions share the project directory. Pi delegates through the RSI `subagent` tool. Codex uses the generated role TOML files and native delegation. The Pi workspace `bash` tool uses `sandbox-exec` on macOS and requires `bubblewrap` on Linux.

```yaml
subagents:
  - name: research-scout
    description: Investigate configuration options and supporting evidence.
    prompt: ./roles/research-scout.md
```
