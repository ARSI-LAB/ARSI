# Reflection 使用指南

[English](reflection.md) | 简体中文 · [快速入门](../getting-started_zh.md)

Reflection 为插件资源文件提出修订。Runtime 检查修改，激活通过校验的版本，并用修订后的配置创建插件实例。后续调用记录实际取得的修订版本。

## 配置 Reflection

六个内置 Agent Policy 都提供 Reflection 配置文件。Recipe 省略 `reflection` 或设为 `true` 时继承该文件。设置 `reflection: false` 可关闭模块，设置 `reflection: { configFile: ./reflection.yaml }` 可完整替换 Policy 文件。如果 Policy 未提供文件，Reflection 默认关闭，Recipe 可以提供自己的文件启用它。没有可用配置文件时，设为 `true` 会在加载时报错。

配置文件必须在 `targets.include` 中授权至少一个本地资源。以下 Harness² 配置授权两个 Proposer 各自的本地资源。

```yaml
trigger: { on: loop-iteration, every: 2 }
evidence: { view: execution }
targets:
  include:
    invariantProposer: '*'
    domainProposer: '*'
budget: { timeoutSeconds: 3600 }
```

WikiSkill、Gym RSI、GEPA 和 Parameter Agent 使用 `proposer: '*'` 选择 `proposer.agent` 已配置的全部本地资源，包括主提示词 `prompt`、`skills` 目录和 `subagents` 中的角色提示词。Harness² 对它的两个 Proposer 分别授权。Operator Search 显式选择 `proposer: [promptsDirectory]` 和 `summarizer: [promptFile]`，评测输入和检索脚本都在编辑范围之外。可用 `proposer: [prompt]` 这样的字段列表缩小范围，`['*']` 也可以表示通配。显式列出的字段指向 URL，或通配符没有匹配到本地路径，均会在加载时报错。`targets.exclude` 可以从已选范围中移除字段，最终必须保留至少一个可编辑资源。

`goal` 可指定目标文件，`implementation.config.prompt` 可指定提示词文件。内置 `reflection.agent` 使用通用目标。省略 `implementation.config.agentRef` 时，它会复用 Policy 声明的唯一 `contract.agent` 绑定。如果 Policy 没有声明或声明了多个这类绑定，Runtime 会用内置 `agent.pi` 创建 `_evolutionAgent`。显式指定的 `agentRef` 必须是 Policy 已声明的 `contract.agent` 绑定名。

默认在每次顶层循环迭代结束时触发，无顶层循环时在实验结束时触发。还可选择 `loop-end`、`experiment-end` 或带串行步骤 ID 的 `after-step`。`every` 指定每匹配多少次边界执行一次。Memory 和 Reflection 同时命中时先执行 Memory。

两个选中的字段引用同一文件时，Reflection 只编辑一份副本。选中的目录也覆盖其内部被选中的文件。如果通过符号链接访问项目，共享资源的字段应使用同一条项目路径。例如，提案器使用 `prompts/`，总结器使用 `prompts/summarize.md`。修改该文件会重新加载两个绑定，修改目录中的其他文件只会重新加载提案器。每次通过校验的更新只为实验生成一个修订版本，涵盖全部受影响的绑定。

证据视图默认为 `training`。可同时读取 `context/evolution/training-summary.json` 中授权的评分反馈，以及脱敏执行文件、调用记录和符合条件的子 Agent 诊断与工作区。对评判结果盲测时，请显式设置 `evidence: { view: execution }`。需要精简调用摘要和有界预览时，选择 `training-summary`。可用 `evidence` 下的 `includeBindings`、`excludeBindings`、`includeSteps`、`excludeSteps` 过滤证据。步骤过滤只作用于 Policy 调用。Reflection 通过绑定过滤选择 Memory 更新回执。`training` 和 `execution` 视图还会提供本次更新产生的 Memory 快照（如有），Memory 快照可以保留其自身证据窗口中的观察结果。需要隔离留出集时，应让两者的过滤范围一致，或排除 `memory` 绑定。`training-summary` 视图仅保留该次更新的回执。即使 Recipe 关闭了 Memory，共用的 Reflection 配置文件仍可设置 `excludeBindings: [memory]`。显式设置 `includeBindings: [memory]` 则要求启用 Memory。证据窗口为空时跳过生成。

## 将版本应用到后续实验

用 `arsi reflection list <experiment-id>` 按从新到旧的顺序查看修订。生成的修订在 `changedBindings` 中列出受影响的绑定。同一存储下的所有实验结束或完成恢复后，先用 `arsi reflection show <revisionID>` 预览累计变更，再用 `arsi reflection apply <revisionID>` 将变更写回原路径。

> [!IMPORTANT]
> **受保护路径与原地写回。** 实验运行期间，Reflection 将通过校验的修订保存在 `.rsi/` 中，后续调用会热重载受影响的绑定。原始文件保持原样，包括内置 Policy 提供的资源。
>
> 原地 `apply` 禁止覆盖框架的 `src/policies/` 和 `src/plugins/`、`dist/`、`node_modules/`、`.rsi/` 或 `.git/` 下的路径，也禁止以整个项目根目录或文件系统根目录为写入目标。目标本身或任一祖先目录是符号链接或 Windows 目录联接（junction）时，写回也会被拒绝。
>
> 生成的联合修订只写回相对初始快照发生内容或文件权限变化的资源根。如果只有用户自有资源发生变化，未改动的内置根不会阻止原地写回。如果受保护的根发生了变化，请导出该修订。

**在后续实验中复用已修订的内置资源**

1. 执行 `arsi reflection show <revisionID> --to ./exported-resources` 预览变更。通过 `sourceRoots` 核对资源及其所属绑定，通过 `destinations` 确认实际导出路径。也可在工作台打开 **Reflection & Memory → Reflection → Preview application**，填写导出目录并选择 **Preview destination**。
2. 执行 `arsi reflection apply <revisionID> --to ./exported-resources`，导出到用户自有的专用目录。整个目标路径中都不能有符号链接或目录联接。修订只有一个目录根时，其内容直接写入该目录。共享资源根的绑定共用同一个导出路径。
3. 修改 `recipe.yaml` 中对应绑定的资源路径，指向导出的文件或目录。以 Proposer 为例，可修改主提示词 `prompt`、`skills` 中的目录或角色提示词 `subagents[].prompt`。后续实验就可以使用这些副本并原地写回。

**需要跨实验持续原地写回时**，建议在编写 Recipe 时就将所有计划演化的资源放入自己项目的专用子目录，并让绑定指向这些副本。启动前运行 `arsi doctor recipe.yaml`，查看 `reflection.targets` 是否提示需要导出内置资源。应用具体修订前，再用 `reflection show` 确认写入路径。

如需恢复基线，请预览并应用初始版本（**Initial version**）。其预览会将所有选中的根与当前目标逐一比较。用 `arsi reflection apply <initialRevisionID> --to ./baseline` 可导出完整基线。共享经验目录见 [Memory](memory_zh.md)。
