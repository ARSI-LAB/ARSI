# Memory 使用指南

[English](memory.md) | 简体中文 · [快速入门](../getting-started_zh.md)

本指南介绍如何在 Policy 中配置和调用 Memory，保存执行经验并传给后续步骤使用。

Memory 保存的是供后续优化参考的经验文档，例如有效的执行方法、失败教训和改进建议。`memory.agent` 根据 Policy 提供的证据整理和更新这些文档。

## 1. 在内置 Policy 中使用 Memory

Harness² 和 WikiSkill 已配置 Memory 插件、提示词、Agent 绑定，以及保存和使用其输出的步骤：

| Policy    | 证据视图           | 使用时机                                                                                                         |
| --------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Harness²  | `execution`        | 每个任务结束后更新经验文档，将 `memoryRef` 传给后续任务的 Proposer。通过 `policy.config.memory` 控制，默认启用。 |
| WikiSkill | `training-summary` | 每轮训练评测后更新经验文档，并将 `memoryRef` 传给本轮 Proposer。没有 `memory` 配置开关。                         |

具体调用和状态更新见 [Harness² Policy](../../../src/policies/harness2/policy.yaml) 和 [WikiSkill Policy](../../../src/policies/wikiskill/policy.yaml)。各视图的可见范围见 [Evidence](../concepts/architecture_zh.md#evidence)。

## 2. 为自定义 Policy 接入 Memory

### 第一步：在 Policy 配置 Memory 绑定和状态

先在 Policy 中配置 Memory 插件，并用状态字段保存当前经验文档版本的标识。下例声明要求 `contract.memory` 的 `memoryUpdater` 绑定，选择 `memory.agent`，用 `state.memoryRef` 保存当前版本的标识。

将以下片段合并到已有 Policy 中。示例假设已经声明并配置名为 `agent` 的 Agent 绑定。

```yaml
# Policy excerpt
require:
  memoryUpdater:
    contract: contract.memory
defaults:
  bindings:
    memoryUpdater:
      plugin: memory.agent
      config:
        agentRef: agent
        prompt: ./memory.md
        evidenceView: execution
state_schema:
  type: object
  properties:
    memoryRef:
      type: [string, 'null']
  required: [memoryRef]
  additionalProperties: false
state:
  memoryRef: null # No experience yet.
```

- `prompt` 是指导 Memory 如何整理经验的提示词文件，必填。该文件需要说明要提炼哪些经验、如何组织文档。
- `evidenceView` 默认 `execution`；学习流程允许使用训练分数和反馈时，可选择 `training-summary`。其他配置与支持的限制见[配置 Schema](../../../src/plugins/shared/agent-editing/schema.ts)和[配置指南](configuration_zh.md)。

### 第二步：在 Policy 的流程中更新并使用经验

**输入：Policy 通过调用步骤的 `with` 传入。**

| 字段              | 必填 | 类型                         | 用途                                                                                             |
| ----------------- | ---- | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `memoryRef`       | 是   | `string \| null`             | 当前经验文档版本的标识，首次调用可传 `null`；后续调用传上次返回的值，在已有经验上继续更新。      |
| `goal`            | 是   | `string`                     | 本次要归纳什么经验，例如总结有效方法和失败原因。                                                 |
| `evidenceRefs`    | 是   | `string[]`                   | 要分析的证据引用列表，例如评测返回的 `measurementRef`；Memory 根据 `evidenceView` 读取可见内容。 |
| `sources`         | 否   | `{ candidateRef: string }[]` | 需要参考的候选列表，`memory.agent` 会读取其文件内容，供归纳经验时参考。                          |
| `observations`    | 否   | `object \| null`             | Policy 提供的补充观察。                                                                          |
| `comparison`      | 否   | `object`                     | 基线、试验候选及选择结果的对照信息，用于分析哪些修改有效。                                       |
| `editConstraints` | 否   | `object`                     | 限制可以修改的经验文件及修改规模。                                                               |

**输出：Policy 从 `steps.<调用步骤 ID>.output` 读取，以下字段都会返回。**

| 字段        | 类型             | Policy 如何使用                                                                                                                        |
| ----------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `status`    | `string`         | 判断本次结果：`updated` 表示已更新，`no-change` 表示无需更新，`failed` 表示更新失败。                                                  |
| `memoryRef` | `string \| null` | 更新后的经验文档版本标识。Policy 将它保存到状态，供下一次 Memory 调用及后续插件使用；未更新或失败时保留输入值，没有经验时仍为 `null`。 |
| `changeRef` | `string \| null` | 本次修改记录的标识，可用于查看改动；仅在 `updated` 时有值，其余情况为 `null`。                                                         |
| `reason`    | `string`         | 更新、无需更新或失败的原因，供 Policy 判断或记录。                                                                                     |

完整字段结构见 [Memory 契约](../../../src/contracts/plugin-types/memory.ts)。

**调用示例：评测 → 更新经验 → 保存返回值 → 生成提案。**

如下所示，可以在评测结束后，先调用 `memoryUpdater` 更新经验文档，再将返回的 `memoryRef` 写入 Policy 状态，最后传给 `proposer`。下面的片段放在名为 `evaluate` 的评测步骤之后，假设已声明 `proposer` 绑定，并由 Policy 输入提供 `input.candidateRef`：

```yaml
# Policy steps excerpt; keep the existing evaluate step before these calls.
steps:
  - id: remember
    type: invoke
    use: memoryUpdater
    with:
      memoryRef: ${{ state.memoryRef }}
      goal: Preserve reusable execution patterns, sources, and uncertainty.
      evidenceRefs:
        - ${{ steps.evaluate.output.measurementRef }}
  - id: save_memory
    type: state
    state:
      memoryRef: ${{ steps.remember.output.memoryRef }}
  - id: propose
    type: invoke
    use: proposer
    with:
      parent: ${{ input.candidateRef }}
      goal: Improve the candidate using authorized evidence and experience.
      evidenceRefs:
        - ${{ steps.evaluate.output.measurementRef }}
      memoryRef: ${{ state.memoryRef }}
```

**后续要让 Agent 使用 Memory，需要在插件中根据 `memoryRef` 读取经验文档，并将内容作为上下文传给 Agent。内置 `proposer.agent` 已实现这部分逻辑；自定义插件如需使用 Memory，也需要自行实现。**

## 3. memory 的执行结果、保存与恢复

| 结果        | 行为                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `updated`   | 保存新一版经验文档，返回新的 `memoryRef`、修改记录 `changeRef` 和原因。Policy 保存新 `memoryRef`，供后续步骤使用。 |
| `no-change` | 继续使用原 `memoryRef`，返回 `changeRef: null`，经验文档没有变化。                                                 |
| `failed`    | 返回原 `memoryRef`、`changeRef: null` 和错误原因，保留原经验文档；调用收据仍为失败，Policy 可以继续。              |

在[工作台](running-experiments_zh.md#工作台)的实验详情中，进入 **Reflection & Memory → Memory**，可查看每次更新的状态和原因，用 `Changes` 查看差异、`Full contents` 阅读经验文档，并通过 `View call` 检查对应调用。

每次有内容更新，Runtime 都会保存一个新版本，已有版本的内容保持不变。`memoryRef` 指向某一版经验文档，`changeRef` 指向这次更新的修改记录。

使用本地存储时，Runtime 将经验文档的内容和目录信息保存在 `.rsi/artifacts/`，Policy 检查点记录当前 `memoryRef`。**恢复同一个实验时，会继续使用已保存的文档版本。内置 Policy 每次启动新实验时，Memory 的初始值都为空（`memoryRef: null`），不会自动继承之前实验的 Memory。**

普通 Memory 更新失败本身不会取消实验。取消、实验预算耗尽和 Runtime 无法保存关键运行记录等情况仍会停止执行。参见[取消与恢复](running-experiments_zh.md#取消与恢复)和 [Memory 实现](../../../src/plugins/memory-agent/service.ts)。
