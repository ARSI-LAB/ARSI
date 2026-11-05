# Reflection 使用指南

[English](../en/reflection.md) | 简体中文 · [用户指南](guide.md) · [运行时事件](runtime-events.md)

Reflection 复盘已完成的执行证据，为后续插件调用提出指导资源修改。开发者选择观察对象、修改权限和调用位置；Runtime 准备输入、校验提案，并在当前实验内启用通过检查的新版本。

本文描述的显式 `configFile` 接口已经实现。内置 [Harness² Policy](../../../src/policies/harness2/policy.yaml) 声明了默认 Reflection 文件，但调用步骤被注释。仅声明配置不会执行 Reflection。

## 1. 配置 Reflection 模块

将 `reflection.yaml` 等配置文件放在 Policy 旁边。以下示例使用 Harness² 的绑定名：

```yaml
evidence:
  - invariantProposer
  - domainProposer
  - composer
  - memoryUpdater
targets:
  invariantProposer:
    resources: [guidance]
  domainProposer:
    resources: [guidance]
goal: ./reflection-goal.md # 目标文档存放 reflection 改进目标的提示词
implementation:
  contract: contract.reflection
  ref: reflection.agent
  config:
    evidenceView: execution
    agentRef: agent
budget:
  timeoutSeconds: 3600
```

| 字段                      | 含义                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `evidence`                | 非空且不重复的 Policy 绑定名，其针对已完成的调用提供经验。                           |
| `targets`                 | 非空的插件绑定映射，列出允许修改的已配置资源名称，例如 `guidance`。                  |
| `goal`                    | 非空 UTF-8 目标文件的路径，该文件需要阐明改进目标，应说明可观察条件。                |
| `implementation.contract` | 必填，必须为 `contract.reflection`。                                                 |
| `implementation.ref`      | 必填的已注册实现，例如 `reflection.agent`；                                          |
| `implementation.config`   | 由所选实现的 Schema 校验；`reflection.agent` 要求用 `agentRef` 显式指定 Agent 绑定。 |
| `budget`                  | 可选的单次模型调用和超时限制，同时受实验剩余总预算约束。                             |

对于 `reflection.agent`，省略 `prompt` 时使用随包提供的 Reflection 提示词，也可以提供自己的文件。实现配置中的相对资源路径以选中的 Reflection 文件为基准。不要在这里配置 `maxContextBytes` 或 `maxModelCalls`：上下文处理由框架负责，模型调用限制应放在 `budget.modelCalls`。

将 `budget.modelCalls` 设为非负整数可限制单次 Reflection 的模型调用次数，设为 `0` 会阻止新增模型调用。将 `budget.timeoutSeconds` 设为计时器范围内的正整数可限制单次执行时间。省略哪个字段，Reflection 就不施加对应的局部上限。已配置的实验和 Agent 限制也会生效。

上面的示例和随包提供的 Harness² Reflection 文件均设置 60 分钟局部超时，不设置模型调用次数上限。Reflection 调用 `agent.pi` 时，Agent 中显式配置的 `executionTimeoutMs` 也会生效。不需要独立的 Reflection 截止时间时，可省略 `budget.timeoutSeconds`。

源码见 [配置校验器](../../../src/runtime/revisions/validation.ts) 和 [内置示例](../../../src/policies/harness2/reflection.yaml)。

### Reflection 收到哪些证据

**Runtime 按完成时间选择相邻两次 Reflection 边界之间、匹配 `evidence` 绑定的调用；**

- 首个窗口从实验开始计算，终态中的成功、失败、取消和未知结果分别保留。
- 为版本对照，每个选中插件还可引用上一版本最近一次已完成调用；大小限制、缺失或截断的证据会明确标注。

**`implementation.config.evidenceView` 默认 `execution`，排除评分侧反馈；`training-summary` 额外允许读取已有、授权的评分、诊断及返回提示。**

- 读取的资源快照包含目标绑定配置中 Schema 声明的路径资源，但修改权限仅限 `targets` 列出的名称。

- 只有窗口内没有可用观察（包括可归因的迟到结果）时，Reflection 才返回 `skipped` 而不调用生成器；
- 源码见 [证据收集](../../../src/runtime/revisions/evidence.ts) 和 [执行流程](../../../src/runtime/revisions/index.ts)。

### Reflection 机制

默认的 [Reflection 提示词](../../../src/plugins/reflection-agent/prompt.md) 说明“怎么反思”，`goal` 文件说明“希望改进什么”。一次反思按下面的流程进行：

1. **先看材料。** 主 Agent 拿到目标、当前资源和本轮执行证据，阅读相关记录，找出值得改进的问题。
2. **自主决定是否分工。** 主 Agent 可以自己分析，也可以用 `run_subagent` 把问题和材料交给子代理。子代理也能继续委派，各级共用预算和取消机制。
3. **汇总修改建议。** 主 Agent 根据证据整理发现、处理相互矛盾的建议，给出允许修改的文件的完整新内容和修改理由。没有有用的改进，就说明原因并保持不变。
4. **检查并生效。** Runtime 检查修改是否符合授权范围、内容要求和版本约束，通过后保存并启用新版本，供当前实验的后续调用读取使用。已完成的调用和结果不会因此改变。

## 2. 显式调用 Reflection

Policy 通过 `defaults.reflection.configFile` 选择默认文件，路径以 Policy 文件为基准。在需要学习的调用之后添加串行步骤：

```yaml
# Excerpt from a custom Policy based on Harness².
defaults:
  reflection:
    configFile: ./reflection.yaml
  # Keep the Policy's required bindings here.
steps:
  # Keep the proposal, evaluation, selection and Memory steps before this call.
  - id: improve_guidance
    type: reflection
```

这是节选，不是完整 Policy，需保留其余 Schema、依赖和流程。启用内置 Harness² 源码中的注释步骤，会改变该构建中使用此 Policy 的行为；如需独立行为，应注册自己的 Policy ID 并在 Recipe 中选择它。见 [Policy 注册](guide.md#4-编写-policy)。

| 配置与流程                 | 结果                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| 无声明，也无调用           | 不加载 Reflection 模块。                                          |
| 有声明，但未执行到调用步骤 | 校验配置，不执行生成器。                                          |
| 有声明，且执行到调用步骤   | Policy 等待 Reflection 结果，可能跳过、无修改、拒绝或启用新版本。 |
| 有调用但无声明             | 在执行前拒绝。                                                    |

Reflection 必须串行执行。编译器或 Runtime 拒绝并行分支中的调用，也检查嵌套的并行步骤块。

### 通过 Recipe 替换文件

```yaml
# Recipe excerpt
reflection:
  configFile: ./reflection-custom.yaml
```

这会为根 Policy 选择**完整替换文件**，根 Policy 必须已经声明 `defaults.reflection`。不会逐字段合并，也不会在流程中插入调用。覆盖路径相对于 Recipe 解析，所选文件内部的路径相对于该文件解析。

替换文件省略 `budget` 时，Reflection 不设局部模型调用预算或时间预算。无效的替换文件会导致校验失败。

## 3. 让自定义插件使用新资源

需要同时具备三项条件：Schema 路径声明、Reflection 授权，以及后续调用读取并使用新资源。

在插件配置 Schema 中声明文件或目录字段：

```ts
import type { JsonSchema } from 'ember-rsi/contracts';

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    prompt: { type: 'string', 'x-rsi-path': 'file' },
    guidance: { type: 'string', 'x-rsi-path': 'directory' },
  },
  required: ['prompt', 'guidance'],
  additionalProperties: false,
};
```

绑定已注册实现，并提供实际资源路径：

```yaml
# Policy defaults excerpt
bindings:
  domainProposer:
    plugin: proposer.custom
    config:
      prompt: ./prompts/domain.md
      guidance: ./guidance
```

Reflection 文件中的 `targets.domainProposer.resources: [guidance]` 授权修改已配置的指导目录，不会因 `prompt` 也是 Schema 路径资源而自动授权它。没有 `x-rsi-path` 的普通字符串不能被选择。资源不存在、路径未配置、文件或目录类型错误，都在调用生成器前报错。

`configFile` 接口允许在授权路径内创建和修改资源内容。Runtime 会在启用版本前校验提案的父版本和资源路径。见 [版本处理](../../../src/runtime/revisions/index.ts)。

插件必须实际读取收到的路径。内置 Proposer 在每次编辑请求时调用 `loadAgentPrompt(config)`：读取基础提示词，递归读取 `config.guidance` 中排序后的 Markdown 文件，将指导文字加入 Agent 请求。见 [共享编辑代码](../../../src/plugins/shared/agent-editing/index.ts)。仅声明 `x-rsi-path` 不会自动将文件内容加入提示词或改变算法，自定义插件负责资源格式与实际使用方式。

## 4. 持久化、启用与恢复

实验执行期间，Reflection **不会覆盖**源 Policy 包或原始指导目录。通过检查的内容保存为实验版本，有效绑定配置接收物化后的资源路径。下文说明如何显式应用到原始用户资源。

使用默认本地存储时：

| 数据                        | 位置                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| 不可变资源快照与修改制品    | `.rsi/artifacts/`                                                     |
| 供插件读取的版本资源        | `.rsi/experiments/<experiment-id>/revisions/<version-key>/resources/` |
| 版本、Reflection 与启用事实 | `.rsi/facts/`                                                         |

执行顺序为：提案 → 范围、内容及父版本校验 → 版本持久化 → 启用 → 后续读取资源。已完成的调用和结果不被重写。仅保存或启用版本不能证明指导内容进入了模型请求；需要验证同一个未结束实验中的后续执行加载并使用了它。

| 结果                     | 行为                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `skipped` 或 `no-change` | 保留当前有效版本。                                                                     |
| `rejected`               | 不启用无效提案。                                                                       |
| 启用前失败               | 保留此前有效配置；重试前检查已保存事实。                                               |
| 持久化或启用期间中断     | 恢复时核对已保存的 Reflection 和启用记录；父版本冲突或已准备输入变化可能导致恢复失败。 |
| 恢复同一个实验           | 恢复已持久化的有效资源和检查点。                                                       |
| 创建新实验               | 从新实验声明的资源开始，不自动继承此前实验的版本。                                     |

### 将版本应用到后续实验

使用与实验相同的 Runtime 数据目录执行：

```text
ember-rsi reflection list [experimentId]
ember-rsi reflection show <revisionID>
ember-rsi reflection apply <revisionID>
```

- `list` 列出初始版、生成版和旧版，可按实验筛选。
- `show` 展示所选内容、记录的目标路径及应用时会新增、覆盖、删除的文件，不执行写入。
- `apply` 将完整快照恢复到记录的原始用户资源路径，后续选用这些路径的新实验即可读取。

注意应用时，存在以下规则，源码见[应用校验与写入](../../../src/runtime/revisions/application.ts)：

1. 在**生成 revision 之前**，通过 Recipe 绑定配置专属用户指导目录，如果之后修改 Recipe 则无法应用之前的reflection内容。
2. **Apply(应用) 会覆盖本地修改，并删除专属目标目录中快照没有的文件；兄弟目录和其他资源不受影响。**
3. 同一 Runtime 数据目录中有活跃或状态尚未解决的实验时，应用会被阻止，需先完成或恢复实验；`list` 和 `show` 仍可使用。不同 Runtime 数据目录不能并发共享这些可写资源。新实验不会自动继承旧版本。
