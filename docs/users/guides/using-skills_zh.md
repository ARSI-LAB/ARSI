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

`proposer.agent` 将 Recipe 锁定的 Skill 目录复制到本轮 workspace 的 `.agents/skills/`。Pi 和 Codex 会发现 Skill，按需读取正文和参考文件。

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

### 配置子 Agent

在同一个 `proposer.agent` 绑定中配置 `subagents`。角色指令和 Skill 会随 Recipe 锁定。父子 Agent 共享工作目录，各自使用独立会话。Pi 通过 RSI 的 `subagent` 工具委派，Codex 使用生成的角色 TOML 和原生委派。Pi 的 workspace `bash` 在 macOS 上使用 `sandbox-exec`，在 Linux 上需要安装 `bubblewrap`。

```yaml
subagents:
  - name: research-scout
    description: Investigate configuration options and supporting evidence.
    prompt: ./roles/research-scout.md
```
