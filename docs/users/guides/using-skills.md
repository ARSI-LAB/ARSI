# Use skills

English | [简体中文](using-skills_zh.md) · [Getting started](../getting-started.md)

## Give a coding assistant the RSI skill

Make the complete [`skills/ember-rsi/` directory](../../../skills/ember-rsi/SKILL.md) available using your assistant's skill discovery mechanism, or point it directly to `SKILL.md` in this checkout. Keep `references/` and `assets/` alongside the entry file so the assistant can follow the instructions and load examples. The skill names its target RSI revision. Ask the assistant to check the current catalog and Schemas before adapting a referenced example.

For example, ask the assistant to create a one-round WikiSkill Recipe with distinct train, validation, and test tasks and validate it. For an existing experiment, give the assistant its ID and ask it to trace the candidate, measurement, and selection receipts.

## Add a skill to the evaluated Bundle

For a WikiSkill baseline, put the file at `baseline/plugins/terminal-base/skills/<name>/SKILL.md`. The baseline's terminal plugin loads the files into the evaluated Agent's system prompt. If you want the loop to edit these skills, include that path in the Application's Target. A valid file has YAML frontmatter with string `name` and `description` and a nonempty Markdown body. See the [completion-checks skill](../../../examples/harness/dsh-wikiskill/baseline/plugins/terminal-base/skills/completion-checks/SKILL.md) and [baseline loader](../../../examples/harness/dsh-wikiskill/baseline/plugins/terminal-base/index.js).

## Give the optimizer a skill

A model-backed Proposer can load a separate skill through its binding's `config.skills`. Each entry points to a skill directory containing `SKILL.md`. For example, Harness² gives its Proposer bindings the [harness-edit skill](../../../src/policies/harness2/skills/harness-edit/SKILL.md) through Policy defaults. To override that list for one binding, set `skills` in the binding's Recipe config and list every directory it should receive. Paths declared there are relative to the Recipe. These skills guide the optimizer's edit workflow. The evaluated Agent receives its own skills from the Bundle.
