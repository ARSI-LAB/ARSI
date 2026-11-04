# 使用 Skill

[English](using-skills.md) | 简体中文 · [快速入门](../getting-started_zh.md)

## 为编程助手接入 RSI Skill

通过助手的 Skill 发现机制提供完整的 [`skills/ember-rsi/` 目录](../../../skills/ember-rsi/SKILL.md)，也可以在任务中直接给出当前检出下的 `SKILL.md` 路径。将 `references/` 和 `assets/` 与入口文件放在一起，让助手能读到引用说明和示例。Skill 标明了对应的 RSI 版本。让助手先核对当前构建注册的 ID 和 Schema，再复用示例。

例如，可以让助手编写一份只运行一轮的 WikiSkill Recipe，使用互不重叠的训练、验证与测试任务，并执行静态校验。诊断已有实验时，可提供实验 ID，让助手追踪候选、测量和选择收据。

## 为被评测的 Bundle 添加 Skill

以 WikiSkill 基线为例，将文件放在 `baseline/plugins/terminal-base/skills/<name>/SKILL.md`。基线的终端插件会将 Skill 加入被评测 Agent 的系统提示词。如果希望优化循环编辑该文件，需把路径纳入 Application 的 Target。文件应有 YAML frontmatter，其中 `name` 和 `description` 为字符串，且 Markdown 正文非空。参见 [completion-checks Skill](../../../examples/harness/dsh-wikiskill/baseline/plugins/terminal-base/skills/completion-checks/SKILL.md) 和 [基线加载代码](../../../examples/harness/dsh-wikiskill/baseline/plugins/terminal-base/index.js)。

## 为优化器配置 Skill

基于模型的 Proposer 可通过绑定的 `config.skills` 加载独立的 Skill。每项指向含有 `SKILL.md` 的目录。Harness² 就通过 Policy 默认绑定向多个 Proposer 提供 [harness-edit Skill](../../../src/policies/harness2/skills/harness-edit/SKILL.md)。若要覆盖单个绑定的列表，在 Recipe 的该绑定配置中设置 `skills`，并列出它需要的全部目录。这里声明的路径相对于 Recipe。该配置指导优化器如何编辑候选，被评测 Agent 的 Skill 仍由其 Bundle 加载。
