# Reflection 使用指南

[English](reflection.md) | 简体中文 · [快速入门](../getting-started_zh.md) · [运行时事件](runtime-events_zh.md)

Reflection 根据执行证据改进目标插件，使后续调用采用改进后的行为。本指南介绍如何选择目标插件、配置修改范围并在 Policy 中调用 Reflection。

- 内置 Harness² Policy 已配置 Reflection 来改进 Invariant Proposer 和 Domain Proposer，目前允许修改它们的 `guidance`。`improve_guidance` 步骤默认处于注释状态。参见 [Harness² Policy](../../../src/policies/harness2/policy.yaml) 和 [Reflection 配置](../../../src/policies/harness2/reflection.yaml)。

内置 `parameter.agent` Policy 声明了[配置搜索 Reflection
模块](../../../src/policies/parameter/agent/reflection.yaml)。设置
`policy.config.reflection: true` 后，在每批完成评测且仍有后续试验时调用；默认关闭，
与 Memory 开关独立。它通过 `training-summary` 读取提案、评测、selector 和已有
Memory 调用记录，仅可修订 Proposer 的 `guidance`，不能修改选择规则、负载或候选参数。
下一次提案加载已激活的版本；达到候选上限或收到无修改提案后不再进行收尾 Reflection。

## 1. 配置 Reflection 模块

`reflection.yaml` 指定参考哪些执行记录、改进哪些插件、允许修改插件的哪些内容，以及由哪个 Reflection 插件和 Agent 完成反思。将文件放在 Policy 旁；下面使用 Harness² 已声明的绑定名，接入自己的 Policy 时按实际绑定名调整：

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
goal: ./reflection-goal.md # The goal file describes what Reflection should improve.
implementation:
  contract: contract.reflection
  ref: reflection.agent
  config:
    evidenceView: execution
    agentRef: agent
budget:
  timeoutSeconds: 3600
```

### 参考哪些记录、改进哪些插件

| 字段                         | 必填 | 作用                                         | 如何填写                                                                                                  |
| ---------------------------- | ---- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `evidence`                   | 是   | 选择哪些插件调用的执行记录作为反思材料。     | 填 Policy 中已有的绑定名列表，如 `[domainProposer, composer]`；至少一项，不能重复。                       |
| `targets`                    | 是   | 选择本次要改进的目标插件。                   | 以 Policy 绑定名为键，如 `domainProposer`，并在每项下填写 `resources`；至少选择一个绑定。                 |
| `targets.<绑定名>.resources` | 是   | 限定对该插件可以修改的配置资源。             | 填插件配置中的资源字段名，如 `[guidance]`。这些字段需已配置路径，并在插件 Schema 中声明为文件或目录资源。 |
| `goal`                       | 是   | 说明希望目标插件解决什么问题、达到什么效果。 | 填目标说明文件的路径，如 `./reflection-goal.md`。文件须为非空 UTF-8 文本。                                |

- 上例参考四个绑定的执行记录，改进的对象是两个 Proposer，具体通过修改它们的 `guidance` 来实现。例如，若 `domainProposer` 的配置中写了 `guidance: ./guidance`，那么 `resources: [guidance]` 授权修改的就是这个 `./guidance` 目录内的文件。

### 由谁执行 Reflection

`implementation` 选择负责提出目标插件改进方案的 Reflection 插件，`implementation.config` 是传给该插件的配置。下表中的配置字段以内置 `reflection.agent` 为例：

| 字段                                 | 必填 | 作用                                         | 如何填写                                                                                                   |
| ------------------------------------ | ---- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `implementation.contract`            | 是   | 声明所选插件需要遵循的公共接口。             | 当前内置为 `contract.reflection`。                                                                         |
| `implementation.ref`                 | 是   | 选择执行反思并提出插件改进方案的实现。       | 填已注册且符合上述契约的插件 ID，如 `reflection.agent`。                                                   |
| `implementation.config.agentRef`     | 是   | 选择实际执行反思的 Agent。                   | 填 Policy 中已有的 Agent 绑定名，如 `agent`；它使用哪个后端和模型，由该绑定配置。                          |
| `implementation.config.evidenceView` | 否   | 决定反思可读取哪些证据内容。                 | `execution`（默认）使用执行证据；允许使用已有、授权评分反馈时，可选 `training-summary`。详见下文证据范围。 |
| `implementation.config.prompt`       | 否   | 指导 Reflection 如何分析证据、改进目标插件。 | 填自定义提示词文件的路径，如 `./reflection-prompt.md`；省略时使用内置提示词。                              |

### 限制一次 Reflection 的开销

`budget` 整体可省略，以下两项也可分别省略：

| 字段                    | 作用                                         | 如何填写                                                                |
| ----------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| `budget.modelCalls`     | 限制一次 Reflection 最多新增多少次模型调用。 | 非负整数，如 `10`；`0` 表示禁止新增模型调用。省略时不设置这项局部上限。 |
| `budget.timeoutSeconds` | 限制一次 Reflection 最长运行多久，单位为秒。 | 正整数，如 `3600` 表示 60 分钟。省略时不设置这项局部上限。              |

注意，实验总预算和 Agent 自身的限制仍同时生效，例如 `agent.pi` 的 `executionTimeoutMs`。

### Reflection 收到哪些证据

**Runtime 按完成时间选择相邻两次 Reflection 边界之间、匹配 `evidence` 绑定的调用；**

- 首个窗口从实验开始计算，终态中的成功、失败、取消和未知结果分别保留。
- 大小限制、缺失或截断的证据会明确标注。

**`implementation.config.evidenceView` 默认 `execution`，排除评分侧反馈；`training-summary` 额外允许读取已有、授权的评分、诊断及返回提示。**

各视图的定义与可见范围见 [Evidence](../concepts/architecture_zh.md#evidence)。

- 读取的资源快照包含目标绑定配置中 Schema 声明的路径资源，但修改权限仅限 `targets` 列出的名称。

- 只有窗口内没有可用观察（包括可归因的迟到结果）时，Reflection 才返回 `skipped` 而不调用生成器；
- 源码见 [证据收集](../../../src/runtime/revisions/evidence.ts) 和 [执行流程](../../../src/runtime/revisions/index.ts)。

### Reflection 机制

默认的 [Reflection 提示词](../../../src/plugins/reflection-agent/prompt.md) 说明“怎么反思”，`goal` 文件说明“希望改进什么”。一次反思按下面的流程进行：

1. **先看材料。** 主 Agent 拿到目标、当前资源和本轮执行证据，阅读相关记录，找出值得改进的问题。
2. **自主决定是否分工。** 主 Agent 可以自己分析，也可以把具体问题交给同一 workspace 中的 `reflection-reviewer`。Pi 使用 `subagent`，主 Agent 和子 Agent 共用 Reflection 的预算和取消机制。Codex 使用原生角色委派。参见 [Agent 后端](configuration_zh.md#agent-与环境变量)。
3. **汇总插件改进方案。** 主 Agent 根据证据整理对目标插件的改进建议、处理相互矛盾的建议，并给出授权文件的完整新内容和修改理由。没有有用的改进，就说明原因并保持不变。
4. **检查并生效。** Runtime 检查修改是否符合授权范围、内容要求和版本约束，通过后，会保存并启用插件的修订版本，供当前实验的后续调用使用。

## 2. 显式调用 Reflection

### 第一步：声明 Reflection 配置文件

在 Policy 的 `defaults.reflection.configFile` 中指定第 1 节编写的配置文件。路径相对于 Policy 文件解析：

```yaml
# Policy excerpt
defaults:
  reflection:
    configFile: ./reflection.yaml
```

Runtime 加载 Policy 时会校验这份配置，实际执行由第二步添加的 Reflection 步骤触发。

#### 通过 Recipe 替换文件

如果某个实验需要使用不同的 Reflection 配置，在 Recipe 中指定：

```yaml
# Recipe excerpt
reflection:
  configFile: ./reflection-custom.yaml
```

这里的 `reflection.configFile` 相对于 Recipe 文件解析，选择的文件仍按第 1 节编写。它会完整替换 Policy 声明的默认配置，因此 Policy 需要先声明 `defaults.reflection`。调用时机仍由 Policy 决定。

### 第二步：指定 Reflection 调用时机

在 Policy 的 `steps` 中，把 `type: reflection` 步骤放到需要反思的位置。例如，放在一轮提案、评测、选择和 Memory 调用之后，让下一轮插件调用使用改进后的版本：

```yaml
# Policy steps excerpt
steps:
  # Existing proposal, evaluation, selection and Memory steps go here.
  - id: improve_guidance
    type: reflection
  # Later calls to target plugins use the activated revisions.
```

`id: improve_guidance` 是这一步的名称，可以自行命名；`type: reflection` 表示执行反思。**Policy 会先等待这次反思结束，再继续后面的步骤。**

- **Reflection 必须串行执行，不能放入并行分支。**
- 如需在后续步骤查看处理结果，可读取 `steps.improve_guidance.output`。

可以自主调整语句在 Policy 的调用处来实现频率安排：

- **每轮优化后反思**：放在优化循环末尾，顺序为“本轮优化 → Reflection → 下一轮优化”。
- **全部优化完成后只反思一次**：放在优化循环之后，顺序为“所有轮次优化 → Reflection”。

## 3. 让自定义插件接入 Reflection

下面以自定义提案插件 `proposer.custom` 为例：它读取提示词和指导文档来生成提案。Reflection 可以通过更新这些内容改进它的提案行为。

### 第一步：声明插件使用哪些文件和目录

在插件的配置 Schema 中，标明 `prompt` 填文件路径、`guidance` 填目录路径。`x-rsi-path` 是给 Runtime 识别路径用的标记，让它能够读取相应内容：

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

### 第二步：在 Policy 中填写实际路径

在 Policy 中声明 `domainProposer` 绑定，选择已注册的 `proposer.custom`，并为它指定要读取的文件和目录：

```yaml
# Policy excerpt
require:
  domainProposer:
    contract: contract.proposer
defaults:
  bindings:
    domainProposer:
      plugin: proposer.custom
      config:
        prompt: ./prompts/domain.md
        guidance: ./guidance
```

- Runtime 会在反思开始前检查文件和目录是否存在、类型是否与 Schema 声明一致。

### 第三步：选择要改进的插件及允许修改的内容

在第 1 节的 `reflection.yaml` 中，选择这个插件作为观察和改进对象：

```yaml
# Reflection configuration excerpt
evidence: [domainProposer]
targets:
  domainProposer:
    resources: [guidance]
```

这里的 `domainProposer` 对应第二步的插件绑定，`resources: [guidance]` 对应该绑定配置的 `./guidance` 目录。Reflection 会参考这个插件的执行记录，通过修改该目录内的指导文档改进插件。若也允许修改提示词，将列表写为 `resources: [prompt, guidance]`。

### 第四步：在插件中使用修改后的内容

**插件需要在后续调用中读取并使用 Runtime 提供的修订配置，才能让 Reflection 的修改影响其行为。**

- 例如，内置 `proposer.agent` 会读取 `prompt` 文件及 `guidance` 目录中的 Markdown 文件，再将内容交给 Agent 使用；

- 自定义插件需按自身逻辑使用修订后的内容。

## 4. 持久化、启用与恢复

实验执行期间，Reflection **不会覆盖**源 Policy 包或原始插件内容。通过检查的内容保存为实验版本，但保留显式应用的路径，下文说明如何显式应用到原始用户资源。

使用默认本地存储时：

| 数据                        | 位置                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| 各版本资源内容与修改记录    | `.rsi/artifacts/`                                                     |
| 供插件读取的版本资源        | `.rsi/experiments/<experiment-id>/revisions/<version-key>/resources/` |
| 版本、Reflection 与启用记录 | `.rsi/facts/`                                                         |

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

也可在[工作台](running-experiments_zh.md#工作台)打开实验详情，进入 **Reflection & Memory → Reflection**，选择版本后点击 `Preview application`。在 `Apply to source files` 对话框中检查目标路径及将新增、覆盖、删除的文件，勾选确认后点击 `Apply changes`。

CLI 和工作台应用时都遵循以下规则，源码见[应用校验与写入](../../../src/runtime/revisions/application.ts)：

1. 在**生成 revision 之前**，通过 Recipe 绑定配置专属用户指导目录，如果之后修改 Recipe 则无法应用之前的reflection内容。
2. **Apply(应用) 会覆盖本地修改，并删除专属目标目录中快照没有的文件；**
3. 同一 Runtime 数据目录中有活跃或状态尚未解决的实验时，应用会被阻止，需先完成或恢复实验；`list` 和 `show` 仍可使用。
