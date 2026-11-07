# 使用 Skill

[English](using-skills.md) | 简体中文 · [快速入门](../getting-started_zh.md)

本指南按使用对象，介绍编程助手、被评测的 Agent 和优化插件的三种接入方式。

## 为 编程Agent 接入 RSI Skill

RSI Skill 用来指导编程助手编写 Recipe、校验配置和排查实验。

1. 将完整的 [RSI Skill 目录](../../../skills/ember-rsi/SKILL.md)放到 Agent 支持的 Skill 目录中，保留 `SKILL.md` 及同级的 `references/`、`assets/`。
2. 让 Agent 读取该 Skill，再提出具体任务，例如“为当前项目编写 Recipe 并执行校验”。也可以直接向助手提供 `SKILL.md` 的路径。

## 为被评测的 Agent 添加 Skill

这类 Skill 随 Baseline Agent Bundle 提供，由 Bundle 中的 Agent 插件读取，指导被评测的 Agent 完成任务。

1. 准备一个包含 `SKILL.md` 的目录。文件中的 `name` 是名称，`description` 是用途，正文写执行指导，例如：

   ```markdown
   ---
   name: output-checks
   description: Check task outputs before finishing.
   ---

   Before finishing, verify that the requested files exist and report any missing outputs.
   ```

2. 将该目录放入 Baseline 中 Agent 插件约定的位置。由插件读取文件，并把内容加入 Agent 的提示词或上下文；自定义 Agent 插件需要实现这部分逻辑。
3. 如果希望优化流程创建或修改这些 Skill，将对应路径纳入 [Target](../getting-started_zh.md#target) 允许修改的范围。

## 为优化插件配置 Skill

支持 `config.skills` 的插件（如 `proposer.agent`）会读取 Skill，将内容作为上下文传给执行优化任务的 Agent。

1. 准备 Skill 目录，例如 `my-experiment/skills/code-editing/SKILL.md`。
2. 在 Recipe 中，向已有插件绑定的配置添加 `skills`：

   ```yaml
   # Recipe excerpt
   bindings:
     proposer:
       config:
         skills:
           - ./skills/code-editing
   ```
