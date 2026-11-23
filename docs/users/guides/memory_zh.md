# Memory 使用指南

[English](memory.md) | 简体中文 · [快速入门](../getting-started_zh.md)

Memory 通过带版本的 UTF-8 文本目录保存可复用经验。实验启动时对配置的目录建立快照，目录不存在或未配置时从空树开始。每次成功更新会激活新的不可变版本。恢复实验时会重新使用其活动版本。

## 配置 Memory

Memory 默认启用。Policy 可设置 `defaults.memory`，Recipe 可通过 `memory` 覆盖。`false` 表示禁用，`true` 表示启用并沿用 Policy 配置或内置默认值，`{ configFile: ./memory.yaml }` 表示选择完整配置文件。Recipe 文件会替换 Policy 文件，省略字段取内置默认值。相对路径按声明该字段的文件解析。Parameter Grid 和 Optuna 默认关闭两种学习能力。

例如，WikiSkill Recipe 可通过 `memory: { configFile: ./wiki-memory.yaml }` 选择以下配置：

```yaml
directory: ./wiki
trigger: { on: after-step, step: train }
evidence:
  view: training-summary
  excludeSteps: [baseline, baseline_score, validate, test]
targets: { include: [proposer] }
implementation:
  config: { agentRef: agent }
```

默认在顶层循环每轮结束时（`loop-iteration`）触发，无顶层循环时在实验结束时（`experiment-end`）触发。`loop-end` 选择顶层循环结束，`after-step` 指定一个串行步骤的 ID。`every: 2` 在第 2、4 等偶数次匹配时执行。Memory 和 Reflection 分别维护证据窗口及计数，同时命中时先执行 Memory。

`evidence.view` 默认为 `execution`。任务允许使用分数和反馈时可选 `training-summary`。使用 `includeBindings`、`excludeBindings`、`includeSteps`、`excludeSteps` 限定观察范围。Runtime 汇总调用、测量投影、候选差异和选择决策。空窗口会跳过生成，更新失败时保留先前的活动快照。

内置 `memory.agent` 提供通用提示词和目标。可用 `goal` 指定目标文件，`implementation.config.prompt` 指定提示词文件，`implementation.config.agentRef` 引用已声明的 Agent 绑定。省略 Agent 绑定时使用内置 `agent.pi`，读取 `MODEL_NAME`、`MODEL_ENDPOINT` 和 `MODEL_API_KEY`。可用 `budget` 下的 `modelCalls`、`timeoutSeconds` 和 `evidenceBytes` 限制单次调用。

## 在 Agent 调用中读取 Memory

符合条件的绑定调用 `ctx.invokeAgent` 时，Runtime 在调用方项目的派生副本中，将本次调用固定的非空快照挂载到 `context/memory/`。`AGENTS.md` 和 `CLAUDE.md` 列出只读文件，Agent 调用回执的 `metadata.memoryVersionRef` 记录版本。`targets.include` 和 `targets.exclude` 按调用方的绑定名指定范围。默认覆盖所有调用 Agent 的业务绑定，Memory 和 Reflection 生成器除外。

## 为后续实验保留经验

```sh
arsi memory list my-experiment
arsi memory show <versionID> --to ./exported-wiki
arsi memory apply <versionID> --to ./exported-wiki
```

若已配置 `directory`，预览和应用默认使用记录的目录。零配置实验可用 `--to` 指定目的地。应用整份快照前应核对将新增、替换和移除的文件。工作台 **Reflection & Memory → Memory** 提供相同的预览和确认流程。写回需要专用的用户目录，且当前存储内所有实验均已结束、状态可确认。后续实验可通过配置该目录复用经验。

有关插件自有资源的修订，见 [Reflection](reflection_zh.md)。
