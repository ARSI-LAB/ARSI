# Reflection 使用指南

[English](reflection.md) | 简体中文 · [快速入门](../getting-started_zh.md)

Reflection 为插件资源文件提出修订。Runtime 检查修改，激活通过校验的版本，并用修订后的配置创建插件实例。后续调用记录实际取得的修订版本。

## 配置 Reflection

Reflection 默认启用。可在 Policy 的 `defaults.reflection` 或 Recipe 的 `reflection` 中设置 `false`、`true` 或 `{ configFile: ./reflection.yaml }`。Recipe 文件会替换 Policy 文件，`true` 会保留已有 Policy 配置文件。参数和资源路径在外部文件中声明。以下 Harness² 配置只允许修订两个指导目录：

```yaml
trigger: { on: loop-iteration, every: 2 }
evidence: { view: execution }
targets:
  include:
    invariantProposer: [guidance]
    domainProposer: [guidance]
implementation:
  config: { agentRef: agent }
budget: { timeoutSeconds: 3600 }
```

默认可编辑符合条件的绑定上已配置的 `x-rsi-path` 资源。`targets.include` 和 `targets.exclude` 按绑定及字段名限定范围。`'*'` 代表该绑定所有可编辑字段。`goal` 可指定目标文件，`implementation.config.prompt` 可指定提示词文件。默认使用 `reflection.agent`、通用目标及内置 `agent.pi`。显式指定的 `agentRef` 必须引用已声明的 Agent 绑定。

默认在每次顶层循环迭代结束时触发，无顶层循环时在实验结束时触发。还可选择 `loop-end`、`experiment-end` 或带串行步骤 ID 的 `after-step`。`every` 指定每匹配多少次边界执行一次。Memory 和 Reflection 同时命中时先执行 Memory。

两个选中的字段引用同一文件时，Reflection 只编辑一份副本。选中的目录也覆盖其内部被选中的文件。例如，提案器使用 `prompts/`，总结器使用 `prompts/summarize.md`。修改该文件会重新加载两个绑定，修改目录中的其他文件只会重新加载提案器。每次通过校验的更新只为实验生成一个修订版本，涵盖全部受影响的绑定。

证据视图默认为 `execution`，仅在允许评分反馈时选择 `training-summary`。可用 `evidence` 下的 `includeBindings`、`excludeBindings`、`includeSteps`、`excludeSteps` 过滤证据。步骤过滤只作用于 Policy 调用。Reflection 通过绑定过滤选择 Memory 更新回执。`execution` 视图还会提供本次更新产生的 Memory 快照（如有），`training-summary` 视图仅保留该次更新的回执。即使 Recipe 关闭了 Memory，共用的 Reflection 配置文件仍可设置 `excludeBindings: [memory]`。显式设置 `includeBindings: [memory]` 则要求启用 Memory。证据窗口为空时跳过生成。

## 将版本应用到后续实验

```sh
arsi reflection list my-experiment
arsi reflection show <revisionID> --to ./exported-guidance
arsi reflection apply <revisionID> --to ./exported-guidance
```

用 `--to` 可导出内置资源，也可将修订保存到自己的专用目录。在工作台打开 **Reflection & Memory → Reflection → Preview application**，输入导出目录，选择 **Preview destination**。修订只包含一个目录根时，其内容直接写入导出目录。其他布局可在预览的 `sourceRoots` 中查看资源路径。共享根的所有绑定使用同一个导出路径。后续 Recipe 的绑定可指向导出的资源以复用修订。

使用 `arsi reflection list <experiment-id>` 按从新到旧的顺序查看修订链。生成的修订在 `changedBindings` 中列出受影响的绑定。用 `arsi reflection show <revisionID>` 预览，再用 `arsi reflection apply <revisionID>` 将累计变更一次写回原路径。写回和导出都只处理相对初始快照发生变化的根。应用或导出初始修订会返回 `unchanged`。用户目录发生变化时，同一修订中未变动的内置根不影响写回。若内置根也有修改，请选择导出目录。应用前请核对预览列出的文件变更。同一存储下所有实验须已结束或完成恢复后才能写入。受保护根目录和链接目标会被拒绝。共享经验目录见 [Memory](memory_zh.md)。
