# 编写插件

[English](writing-plugins.md) | 简体中文 · [快速入门](../getting-started_zh.md)

本指南介绍如何选择插件契约、填写接口字段、实现并注册插件，以及通过 Recipe 和 Policy 接入 Runtime。

插件提供一项业务能力，Policy 决定何时调用它，Recipe 选择具体实现并提供配置。流程本身的字段见[编写 Policy](writing-policies_zh.md)，内置实现的配置见[配置指南](configuration_zh.md)和[内置组件](built-in-components_zh.md)。

## 选择扩展边界

| 需求                                               | 扩展方式                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 修改任务、限制、模型或现有提示词路径               | 覆盖对应的 Recipe 配置或绑定。                                                                  |
| 替换推理和工具执行，复用 Proposer 的证据与编辑处理 | 实现 `contract.agent`，替换被调用的 Agent 绑定。                                                |
| 替换完整的提案流程                                 | 实现 `contract.proposer`。                                                                      |
| 管理新的优化目标、候选提交或运行实例               | 实现 `contract.application`。                                                                   |
| 接入新的评测方式                                   | 按调用方要求实现 `contract.agentbench`、`contract.inferencebench` 或 `contract.operatorbench`。 |
| 修改候选选择、经验整理或插件自进化逻辑             | 分别实现 Selector、Memory 或 Reflection 契约。                                                  |
| 增加参数搜索算法                                   | 实现 `contract.proposer-grid` 或 `contract.proposer-parameter-search`。                         |
| 修改编排、状态或停止规则                           | 注册自定义 Policy。                                                                             |

### 分清契约、实现、绑定和步骤

| 名称        | 例子                   | 填在哪里                                                              |
| ----------- | ---------------------- | --------------------------------------------------------------------- |
| 契约 ID     | `contract.proposer`    | Policy 的 `require.proposer.contract`，规定输入输出。                 |
| 插件实现 ID | `proposer.keep-parent` | 插件定义的 `id`、绑定声明的 `plugin`。                                |
| 绑定名      | `proposer`             | `require`、`defaults.bindings`、Recipe 的 `bindings` 和步骤的 `use`。 |
| 步骤 ID     | `propose`              | 步骤的 `id`，结果通过 `steps.propose.output` 读取。                   |
| Policy ID   | `policy.my-search`     | Policy 的 `id`、注册 ID 和 Recipe 的 `policy.id`。                    |

绑定名由 Policy 声明，不是固定的角色枚举。例如 `domainProposer` 和 `skillProposer` 都可以要求 `contract.proposer`，再绑定不同实现。一个普通插件实现一个公共契约；多种生命周期动作放进同一个 `execute` 的 `action` 联合类型。Policy 是独立的流程定义，不作为插件绑定，也没有子 Policy 绑定。

## 选择公共契约

从下面选择调用方要求的契约，复用导出的对象和类型。契约拥有 `id`、`input_schema`、`output_schema`；插件拥有自己的配置 Schema。即使 TypeScript 类型看起来兼容，Runtime 仍会检查契约 ID 和 Schema 身份。

| 契约与字段定义                                                                                         | 导出的契约对象                    | 输入 / 输出类型                                    |
| ------------------------------------------------------------------------------------------------------ | --------------------------------- | -------------------------------------------------- |
| [contract.application](../../../src/contracts/plugin-types/application.ts)                             | `applicationContract`             | `ApplicationInput` / `ApplicationOutput`           |
| [contract.agent](../../../src/contracts/plugin-types/agent.ts)                                         | `agentContract`                   | `AgentInput` / `AgentOutput`                       |
| [contract.proposer](../../../src/contracts/plugin-types/proposer.ts)                                   | `proposerContract`                | `ProposerInput` / `ProposerOutput`                 |
| [contract.proposer-operator](../../../src/contracts/plugin-types/proposer-operator.ts)                 | `operatorProposerContract`        | `OperatorProposerInput` / `OperatorProposerOutput` |
| [contract.agentbench](../../../src/contracts/plugin-types/agentbench.ts)                               | `agentbenchContract`              | `AgentbenchInput` / `AgentbenchOutput`             |
| [contract.inferencebench](../../../src/contracts/plugin-types/inferencebench.ts)                       | `inferencebenchContract`          | `InferencebenchInput` / `InferencebenchOutput`     |
| [contract.operatorbench](../../../src/contracts/plugin-types/operatorbench.ts)                         | `operatorbenchContract`           | `OperatorbenchInput` / `OperatorbenchOutput`       |
| [contract.selector-metrics](../../../src/contracts/plugin-types/selector-metrics.ts)                   | `metricSelectorContract`          | `MetricSelectorInput` / `MetricSelectorOutput`     |
| [contract.selector-artifacts](../../../src/contracts/plugin-types/selector-artifacts.ts)               | `artifactSelectorContract`        | `ArtifactSelectorInput` / `ArtifactSelectorOutput` |
| [contract.memory](../../../src/contracts/plugin-types/memory.ts)                                       | `memoryContract`                  | `MemoryInput` / `MemoryOutput`                     |
| [contract.reflection](../../../src/contracts/plugin-types/reflection.ts)                               | `reflectionContract`              | `ReflectionInput` / `ReflectionOutput`             |
| [contract.proposer-grid](../../../src/contracts/plugin-types/proposer-grid.ts)                         | `gridProposerContract`            | `GridProposerInput` / `GridProposerOutput`         |
| [contract.proposer-parameter-search](../../../src/contracts/plugin-types/proposer-parameter-search.ts) | `parameterSearchProposerContract` | `ParameterSearchInput` / `ParameterSearchOutput`   |

以下字段按当前公共契约列出。未标为可选的字段都必须提供；可选不代表接受 `null`。`candidateRef`、`measurementRef` 等引用应使用 Runtime 返回的值，不能用本地文件路径代替。

### Application：目标和实例生命周期

输入和输出均带相同的 `action`。`capability` 是 Application 公布的能力名，例如 `agentbundle`，不是插件 ID；具体 `execution` 对象由 Application 与消费它的 Evaluator 约定。

| `action`     | 其余输入字段                                                   | 其余输出字段                                                                   |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `initialize` | 无。                                                           | `initialCandidateRef`、`target` 对象、`capabilities` 字符串数组。              |
| `commit`     | `parentCandidateRef`、`editRef`；可选 `editConstraints` 对象。 | `status: created \| no-change`、`candidateRef`、`diffRef`（字符串或 `null`）。 |
| `acquire`    | `candidateRef`、`instanceId`、`capability`。                   | `instanceId`、`execution` 对象。                                               |
| `release`    | `instanceId`。                                                 | `instanceId`、`status: released`。                                             |

Application 负责校验目标范围、封存候选以及实例的获取和释放。Evaluator 使用 `context.withInstance()` 消费实例。初始化返回的 `initialCandidateRef` 在 Policy 表达式中映射为 `application.initialCandidate`；`context.applicationMetadata()` 仍使用 `initialCandidateRef`。

### Agent：推理和工具执行

| 输入字段        | 必需 | 类型与含义                                                 |
| --------------- | ---- | ---------------------------------------------------------- |
| `goal`          | 是   | 字符串，本次目标。                                         |
| `prompt`        | 是   | 字符串，本次提示词内容。                                   |
| `outputSchema`  | 是   | 对象，要求返回的 JSON 对象必须符合的 Schema。              |
| `input`         | 否   | 任意 JSON 值，补充业务输入。                               |
| `files`         | 否   | 文件名到字符串内容的映射，表示虚拟文件。                   |
| `agentRef`      | 否   | Agent 绑定名。`invokeAgent()` 省略时使用 `agent.default`。 |
| `maxModelCalls` | 否   | 大于等于 1 的整数，传输层支持时限制实际模型请求尝试数。    |

返回值是 JSON 对象。公共契约的 `output_schema` 只约束它是对象，自定义后端还必须校验本次请求的 `input.outputSchema`。说明后端的工具和执行权限，传递取消信号，并释放进程、会话等资源。`files` 本身不授予宿主机文件访问权限。

拥有模型传输层的后端用 `context.charge('modelCalls', 1)` 为实际请求尝试记账，包括重试与输出纠正。没有权威请求次数的后端（例如原生 Codex）必须声明此用量不可用，不能把缺失计数记为零，也不能声称可以执行模型调用预算。内置后端的配置字段见[Agent 配置](configuration_zh.md#agent-与环境变量)。

### Proposer：产生候选

| 输入字段          | 必需 | 类型与含义                                                     |
| ----------------- | ---- | -------------------------------------------------------------- |
| `parent`          | 是   | 父候选引用。                                                   |
| `goal`            | 是   | 非空字符串，修改目标。                                         |
| `evidenceRefs`    | 是   | 非空引用字符串组成的数组；数组可以为空。                       |
| `sources`         | 否   | `{ candidateRef, measurementRef? }` 数组，提供参考候选及测量。 |
| `memoryRef`       | 否   | 经验引用或 `null`。                                            |
| `editConstraints` | 否   | 本次编辑限制对象，由实现解释并落实到写入边界。                 |

输出只能是以下两种形态，均需 `rationale` 字符串：

| `status`    | 其余输出字段                                    |
| ----------- | ----------------------------------------------- |
| `created`   | `candidateRef`、非空的 `diffRef`、`rationale`。 |
| `no-change` | `candidateRef`、`diffRef: null`、`rationale`。  |

需要修改文件时，在工作区中编辑，再通过 Application 的 `commit` 提交候选，并在 `finally` 中释放工作区。可参考 [Skill 的确定性 Proposer](../../../skills/ember-rsi/assets/minimal/extension/operations.mjs)。内置 Agent Proposer 的模型编辑协议见[共享编辑代码](../../../src/plugins/shared/agent-editing/index.ts)；换掉 Agent 后仍需遵守该调用方要求的输出 Schema。

### 评测、选择、Memory 和 Reflection

| 契约                          | 输入字段                                                                                                                                                            | 输出字段                                                                                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract.agentbench`         | `candidateRef`、`taskIds`（非空且不重复的非空字符串数组）。                                                                                                         | `measurementRef`。                                                                                                                                                                                                                                                                      |
| `contract.inferencebench`     | `candidateRef`。                                                                                                                                                    | `measurementRef`。                                                                                                                                                                                                                                                                      |
| `contract.selector-metrics`   | `incumbentMeasurementRef`、`candidateMeasurementRef`。                                                                                                              | `accepted`、`candidateFeasible`、`selectedCandidateRef`、`measurementRef`、`decisionRef`、`reason`、`metric`、`incumbentValue`、`candidateValue`、`selectedValue`。前两项是布尔值；`incumbentValue`、`selectedValue` 为数值，`candidateValue` 为数值或 `null`（候选未通过资格检查时）。 |
| `contract.selector-artifacts` | 非空的 `candidates` 数组，每项为 `{ candidateRef, measurementRef }`；`rubric` 非空字符串。                                                                          | `candidateRef`、`measurementRef`、`decisionRef`。                                                                                                                                                                                                                                       |
| `contract.memory`             | `memoryRef`（引用或 `null`）、`goal`、`evidenceRefs`；可选 `editConstraints`、`comparison`、`observations`（对象或 `null`）、`sources`（`{ candidateRef }` 数组）。 | `status: updated` 时返回非空引用 `memoryRef`、`changeRef` 和字符串 `reason`；`status: no-change \| failed` 时返回 `memoryRef`（引用或 `null`）、`changeRef: null` 和 `reason`。                                                                                                         |
| `contract.reflection`         | `parentRevisionRefs`（非空的绑定名到修订引用的映射）、`resourceRef`、`goal`、`evidenceRefs`、`editConstraints`。                                                    | `status: proposed` 时返回 `proposal: { parentRevisionRefs, resourceRef, changeRef }` 和 `reason`；`status: no-change` 时返回 `proposal: null` 和 `reason`。                                                                                                                             |

Memory 的可选 `comparison` 包含 `baselineCandidateRef`、`probes` 和 `selection`。`probes` 是非空映射，每组为非空的 `{ candidateRef, measurementRef, slot? }` 数组，`slot` 是非负整数；`selection` 包含 `candidateRef`、`measurementRef`、`decisionRef`。

Evaluator 先记录符合[公共 Measurement 协议](../../../src/contracts/models/measurement.ts)的测量，再返回引用。测量的 `status` 可选 `succeeded / failed / cancelled / unknown`，`coverage` 可选 `complete / partial / none / unknown`。指标的 `status` 可选 `available / unavailable`，可用值的 `kind` 可选 `scalar / distribution`；不可用值用 `value: null` 并提供 `reason`。内置指标选择器先检查已配置的 `eligibility`；新候选未通过时直接拒绝，无需读取其目标指标。进入指标比较的测量必须完整、成功、可比较且指标定义一致，分布指标还需显式选择统计量。资格检查、额外约束和最小改进比例见[指标选择](configuration_zh.md#指标选择)。

Reflection 插件根据执行证据对目标插件提出修订建议。证据、结构校验、持久化和启用归 Runtime；插件返回 `proposed` 不代表修订已经启用。步骤的 `activated / no-change / skipped / rejected` 是 Runtime 的处理结果，详见 [Reflection 指南](reflection_zh.md)。

### 算子优化

`policy.operator-search` 使用专门的 Proposer 和 Evaluator 契约，分别编排算子修改与评测：

| 契约与动作                                        | 输入用途                                                                                                            | 输出                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract.proposer-operator`，`action: propose`   | `phase: static` 从入口候选和基线测量出发分析源码；`phase: metrics` 从当前最优候选、评测和性能分析测量出发改进性能。 | `status`、`candidateRef`、`diffRef`、`analysisRef`、`rationale`、`reasonCode`；状态为 `created`、`no-change` 或 `failed`，失败时还有 `errorRef`。 |
| `contract.proposer-operator`，`action: repair`    | 传入失败候选、对应测量和分析引用，修复该候选。                                                                      | 与 `propose` 相同的结果结构。                                                                                                                     |
| `contract.proposer-operator`，`action: summarize` | 汇总当前阶段的候选、测量和选择结果，更新后续调用使用的历史。                                                        | `historyRef`、`summaryRef`。                                                                                                                      |
| `contract.operatorbench`，`action: evaluate`      | `candidateRef`、`caseIds`，指定要检查正确性并测量耗时的候选与用例。                                                 | `measurementRef`。                                                                                                                                |
| `contract.operatorbench`，`action: profile`       | 在 `candidateRef`、`caseIds` 外传入 `assessmentMeasurementRef`，引用该候选已有的评测结果。                          | `measurementRef`、`collectionStatus: completed \| unavailable`。                                                                                  |

输出还包含与输入一致的 `action`。上表概括各动作的用途；实际调用还需按 [Proposer 契约](../../../src/contracts/plugin-types/proposer-operator.ts)中对应的 `phase` / `action` 分支填写目标、轮次、分析及历史等字段。完整流程见 [Operator Search Policy](../../../src/policies/operator-search/policy.yaml)，运行配置见[算子优化示例](../../../examples/artifacts/kernel/transpose-copy/README.zh-CN.md)。

### 参数搜索

`contract.proposer-grid` 接收 `parent` 和非负整数 `cursor`。返回 `status: candidate` 时包含 `candidateRef`、`parameters` 对象、`nextCursor`、`totalCandidates`；返回 `status: exhausted` 时只有 `nextCursor`、`totalCandidates`。`nextCursor` 为非负整数，`totalCandidates` 为正整数。

`contract.proposer-parameter-search` 通过 `action` 区分三个动作：

| `action`     | 其余输入字段                                             | 其余输出字段                                                                                                                                                          |
| ------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize` | `parent`。                                               | `stateRef`。                                                                                                                                                          |
| `suggest`    | `stateRef`。                                             | `status: candidate` 时返回 `stateRef`、`trialId`、`candidateRef`、`parameters`；`status: stopped` 时返回 `stateRef` 和 `reason: search-exhausted \| sampling-limit`。 |
| `observe`    | `stateRef`、`trialId`、`measurementRef`、`decisionRef`。 | 新的 `stateRef`。                                                                                                                                                     |

返回值也必须带对应的 `action`。搜索状态通过引用保存，循环与停止条件由 Policy 编排，完整调用示例见 [Optuna Policy](../../../src/policies/parameter-optuna/policy.yaml)。

## 实现插件生命周期

插件按 `schema.ts`（配置）、`service.ts`（业务逻辑与清理）、`index.ts`（组装定义）组织。输入输出 Schema 只由公共契约声明，不在实现中重复定义。仓库内插件导入本地契约；外部工程从 `ember-rsi` 或 `ember-rsi/contracts` 导入，不使用私有 `src/*` 子路径。

### 插件定义字段

`OperationDefinition<I, O, C>` 的三个类型参数分别是契约输入、契约输出和插件配置。定义只接受以下字段，参见[操作契约](../../../src/contracts/operation.ts)：

| 字段                   | 必需 | 含义                                                                                       |
| ---------------------- | ---- | ------------------------------------------------------------------------------------------ |
| `id`                   | 是   | 唯一的实现 ID，例如 `proposer.keep-parent`。不能与已注册的插件或 Policy 重名。             |
| `description`          | 否   | 实现说明。                                                                                 |
| `contract`             | 是   | 上表中导入的公共契约对象，不是契约 ID 字符串。                                             |
| `configSchema`         | 是   | 本实现的配置 Schema；没有配置时也声明对象 Schema。                                         |
| `create`               | 是   | 异步工厂 `create(config, context)`，返回插件实例。                                         |
| `implementationDigest` | 否   | 实现指纹，用于锁定与恢复身份校验。发布实现时可填构建内容摘要；影响行为的代码变化时应更新。 |

未提供 `implementationDigest` 时，Registry 根据工厂函数文本、契约和配置 Schema 生成指纹。该方式不会自动覆盖被导入的辅助模块；需要可靠识别这类变化时，应提供覆盖实际实现的摘要。

### 实例方法与调用顺序

| 方法                                                  | 必需 | 职责                                                           |
| ----------------------------------------------------- | ---- | -------------------------------------------------------------- |
| `execute(input, context): Promise<O>`                 | 是   | 执行业务逻辑，返回符合契约的 JSON 数据。                       |
| `dispose(): Promise<void>`                            | 是   | 释放实例拥有的进程、连接、监听器等资源；没有资源时可为空实现。 |
| `canRetry(input, receipt, context): Promise<boolean>` | 否   | 通过只读检查确认一个已确定为失败或取消的调用可以安全重放。     |

加载 Recipe 只装配定义，不调用 `create` 或 `execute`。Runtime 在需要运行实例时调用工厂，并在调用边界校验输入输出、记录收据与计费。一次实例可以服务多次调用；并行分支可能同时调用同一绑定，因此每次调用的数据和临时资源应保存在本次调用的局部作用域中。配置修订可以产生新实例，由 Runtime 管理版本与释放。

工厂上下文用于实例资源，执行时使用本次 `execute` 收到的上下文，不把首次调用的 `callId`、取消信号等保存为以后调用的值。工厂若在返回实例前失败，需自行释放已创建的资源。`dispose` 没有参数，所需实例资源由闭包保存。

`canRetry` 只有在重放不会重复副作用时才返回 `true`，适用于已确定为失败或取消的调用。Runtime 归档原收据，并正常为重试记账；该钩子不在普通执行中自动增加重试循环，也不能自动重放结果未知或仍在运行的调用。

## 定义配置 Schema

配置是 JSON 对象，`create` 收到的是合并、校验、补全默认值并解析路径后的配置。常用 Schema 字段如下；配置字段叫什么、接受哪些值，由插件决定。

| Schema 字段                          | 可选值或写法                                                                      | 用途                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `type`                               | `object`、`array`、`string`、`integer`、`number`、`boolean`、`null`，或类型数组。 | 声明类型，例如 `{ type: ['string', 'null'] }`。      |
| `properties`                         | 字段名到 Schema 的映射。                                                          | 描述对象字段；仅列在这里不会使字段必填。             |
| `required`                           | 字段名数组。                                                                      | 声明必填字段。                                       |
| `additionalProperties`               | 通常为 `false`；也可为 Schema。                                                   | 拒绝拼错或未知的字段，或约束映射值。                 |
| `enum` / `const`                     | 如 `enum: ['maximize', 'minimize']` / `const: 'retain-incumbent'`。               | 限定可选值或固定值。                                 |
| `default`                            | 与字段类型匹配的 JSON 值。                                                        | 在配置合并后补齐省略值；不是由 TypeScript 自动提供。 |
| `minimum` / `maximum`                | 数值。                                                                            | 数值范围；计数通常还需 `type: integer`。             |
| `minLength` / `pattern`              | 长度 / 正则表达式字符串。                                                         | 字符串限制。                                         |
| `items` / `minItems` / `uniqueItems` | 元素 Schema / 最少数量 / 布尔值。                                                 | 数组内容、大小和唯一性。                             |
| `oneOf`                              | Schema 数组。                                                                     | 声明按 `action` 等字段区分的互斥结构。               |
| `x-rsi-path`                         | `file` 或 `directory`，放在路径字符串的 Schema 上。                               | 标记需要按声明来源解析的文件或目录路径。             |

只解析 Schema 明确标记的路径。继承值相对于 Policy 文件，Recipe 覆盖值相对于 Recipe 文件；嵌套对象和数组中的路径也按实际来源处理。路径标记不代替文件存在性和修改权限检查。普通字符串、资源引用和 `${NAME}` 环境引用不会统一进行路径或环境变量替换；环境引用由所属插件解释。`${{ ... }}` 则用于 Policy/Recipe 数据流模板。

可对照[指标选择器的配置 Schema](../../../src/plugins/selector-metrics/schema.ts)：`direction` 可选 `maximize / minimize`，`statistic` 可选 `mean / p50 / p95 / p99`，`tieBreak` 只有 `retain-incumbent`。这些是 `selector.metric` 的配置，不属于所有 Selector 的公共输入。

## 写一个最小插件

下面实现一个始终保留父候选的 Proposer，完整展示三个文件，不调用模型。它适合先验证注册与数据流；需要真实编辑时，再参考前面的确定性 Proposer。

在已安装 `ember-rsi` 的 TypeScript ESM 工程中，将三个文件放在 `src/proposer-keep-parent/`，编译到 `dist/proposer-keep-parent/`。相对导入使用构建后的 `.js` 扩展名。

`schema.ts`：

```ts
import type { JsonSchema } from 'ember-rsi/contracts';

export type KeepParentConfig = { reason: string };

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    reason: { type: 'string', minLength: 1 },
  },
  required: ['reason'],
  additionalProperties: false,
};
```

`service.ts`：

```ts
import type {
  Operation,
  ProposerInput,
  ProposerOutput,
  RuntimeContext,
} from 'ember-rsi/contracts';
import type { KeepParentConfig } from './schema.js';

export async function createKeepParent(
  config: KeepParentConfig,
  _context: RuntimeContext,
): Promise<Operation<ProposerInput, ProposerOutput>> {
  return {
    async execute(input, context): Promise<ProposerOutput> {
      context.signal.throwIfAborted();
      await context.readCandidate(input.parent);
      return {
        status: 'no-change',
        candidateRef: input.parent,
        diffRef: null,
        rationale: config.reason,
      };
    },
    async dispose(): Promise<void> {},
  };
}
```

`index.ts`：

```ts
import {
  proposerContract,
  type OperationDefinition,
  type ProposerInput,
  type ProposerOutput,
} from 'ember-rsi/contracts';
import { configSchema, type KeepParentConfig } from './schema.js';
import { createKeepParent } from './service.js';

export const keepParentDefinition: OperationDefinition<
  ProposerInput,
  ProposerOutput,
  KeepParentConfig
> = {
  id: 'proposer.keep-parent',
  description: 'Keep the parent candidate without edits.',
  contract: proposerContract,
  configSchema,
  create: createKeepParent,
};
```

## 使用 RuntimeContext

公开字段和方法定义在[执行上下文](../../../src/contracts/runtime/execution.ts)与[服务接口](../../../src/contracts/runtime/services.ts)。候选、测量、预算和调用收据归 Manager，插件通过以下能力访问它们。

### 上下文字段

| 字段                                 | 含义                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `experimentId`                       | 当前实验 ID。                                                                                                  |
| `callId` / `bindingId`               | 当前受控调用 ID / 绑定名。                                                                                     |
| `idempotencyKey`                     | 当前调用的幂等键，可传给支持幂等写入的外部服务。                                                               |
| `signal`                             | 本次业务调用的取消信号，传给外部请求、子进程及耗时操作。                                                       |
| `cleanup`                            | 独立的清理取消信号，用于业务信号取消后的资源释放。                                                             |
| `scope`                              | 可选的局部预算作用域，含 `id`、`signal`、`limits`；限制字段有 `modelCalls`、`elapsedWallMs`、`evidenceBytes`。 |
| `directory`                          | 当前调用的数据目录。                                                                                           |
| `rootDirectory` / `dataDirectory`    | 宿主工作根目录 / Runtime 数据根目录，默认数据根目录为工作根目录下的 `.rsi/`。                                  |
| `artifacts` / `facts` / `workspaces` | 不可变产物、事实存储和临时工作区服务。                                                                         |
| `event`                              | 实例作用域的事件管线；订阅与返回的取消订阅函数见 [Runtime 事件](runtime-events_zh.md)。                        |

当前上下文没有 `phase` 字段，也不根据步骤 ID 推断报告阶段。报告通过普通步骤与显式输入组织。

### 读取、写入和受控调用

| 方法                                                      | 返回值与用途                                                                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readCandidate(ref)`                                      | 返回 Candidate，含 `ref`、`artifactRef`、`parentRef`、`experimentId`。                                                                                                                                                    |
| `recordCandidate(artifactRef, parentRef)`                 | 返回候选引用；通常由 Application 在完成目标检查后使用。                                                                                                                                                                   |
| `readMeasurement(ref)` / `recordMeasurement(measurement)` | 读取测量 / 校验并保存测量，写入返回引用。相同内容重复提交返回稳定引用，保存的是输入副本。                                                                                                                                 |
| `application(input)`                                      | 按 Application 的 `action` 协议受控调用当前 Application。                                                                                                                                                                 |
| `applicationMetadata()`                                   | 返回初始化元数据：`target`、`capabilities`、`initialCandidateRef`。                                                                                                                                                       |
| `invoke(bindingName, input)`                              | 调用本实验的绑定，经过契约校验、预算、收据和当前修订选择。                                                                                                                                                                |
| `invokeAgent(input)`                                      | 按 `input.agentRef` 调用 Agent 绑定，省略时使用 `agent.default`；不会自动选择名为 `agent` 的绑定。                                                                                                                        |
| `withInstance(candidateRef, capability, use)`             | 获取执行实例，调用异步 `use(execution)`，并在成功、失败和取消时协调释放。                                                                                                                                                 |
| `readEvidence(refs, options?)`                            | 读取证据。省略 `format` 时返回 JSON 投影，也可设为 `files` 读取文件；`view` 可选 `execution / training-summary / delivery`，省略时为 `execution`；`maxBytes` 是正安全整数，指定请求字节上限，作用域或投影可施加更低上限。 |
| `charge(metric, amount)`                                  | 记录用量并执行预算检查，必须 `await`。                                                                                                                                                                                    |
| `extend(properties)`                                      | 创建继承当前上下文的子作用域，只遮蔽提供的字段；嵌套对象仍共享引用，修改前先创建新值。                                                                                                                                    |

`artifacts` 支持 `putJson`、`readJson`、`capture`、`materialize`。`workspaces` 支持 `create(artifactRef?, parentCandidateRef?)`、`read(ref)`、`release(ref)`，工作区包含 `ref`、`directory` 和 `parentCandidateRef`。`facts` 提供底层 `read / write / list` 和可选 `scan`；候选、测量和收据仍应通过各自的公开管理接口处理。

嵌套业务调用使用 `invoke`、`invokeAgent` 或 `application`，才能经过 Runtime 控制。不要直接创建另一个插件实例来绕过这些边界。Evaluator 为实际评测调用 `charge('evaluationRuns', 1)`；模型后端为实际请求尝试记 `modelCalls`。`operations` 由 Runtime 统一计数，插件不重复计费。

调用拥有的工作区、文件和临时进程在 `finally` 中释放；实例拥有的长期资源在 `dispose` 中释放。失败和取消向外传播，只有契约明确规定的业务结果才用 `no-change`、`failed` 等状态返回，不把异常当作成功输出。

## 把插件接到 Policy 和 Recipe

下面是 Policy 中与插件有关的片段；完整 Policy 仍需输入输出 Schema 等字段，见[编写 Policy](writing-policies_zh.md)。`with` 是每次调用的输入，`config` 是绑定配置，两者分别校验。

```yaml
require:
  proposer:
    contract: contract.proposer
defaults:
  bindings:
    proposer:
      plugin: proposer.keep-parent
      config:
        reason: Keep the baseline for this demonstration.
steps:
  - id: propose
    type: invoke
    use: proposer
    with:
      parent: ${{ application.initialCandidate }}
      goal: Check the plugin integration.
      evidenceRefs: []
```

Recipe 可以只覆盖配置，保留默认实现：

```yaml
bindings:
  proposer:
    config:
      reason: Keep the parent in this experiment.
```

### 绑定字段和合并规则

`defaults.bindings.<name>` 和 `bindings.<name>` 均只接受 `plugin`、`config` 两个字段。`plugin` 是实现 ID，可在覆盖项中省略；`config` 必须是对象，省略表示没有配置覆盖。Application 则放在 Recipe 的 `application`，且必须显式提供 `plugin`。

| 情况                                           | 装配行为                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| Recipe 省略某项                                | 继承 Policy 的默认声明。                                                   |
| 同一实现，两边字段值都是普通对象               | 递归合并。                                                                 |
| 覆盖值是数组、标量或 `null`                    | 整体替换；`null` 不表示删除，仍须满足 Schema。`config` 本身不能是 `null`。 |
| 显式换成不同的 `plugin`                        | 丢弃旧实现配置，按新配置及其 Schema 默认值装配。                           |
| 合并后没有实现、缺少必需绑定或出现未声明的绑定 | 加载失败，并报告绑定名。                                                   |
| 实现不满足 `require` 的契约                    | 加载失败。                                                                 |

合并后校验最终配置并补齐默认值，路径保留各字段的声明来源。更换 Agent 绑定时，还要确认业务插件的 `agentRef` 指向该绑定。声明 ID 不会导入代码，文件存在也不会自动启用插件。参见[绑定加载器](../../../src/runtime/loaders/binding.ts)。

## 为 CLI 注册外部扩展

默认扩展从 `~/.ember-rsi/plugins/<name>/index.mjs` 按名称顺序加载，之后加载额外的 `--plugin-dir` 目录。主目录不存在时正常启动；已发现的扩展无效时启动失败。实验数据仍在工作目录的 `.rsi/`。嵌入宿主可设置 `homeDirectory: false` 隔离本机扩展。

所有 CLI 命令都接受可重复的 `--plugin-dir <directory>`。每个目录包含 ESM 文件 `index.mjs`，导出 `register(registry)`，可以是异步函数。扩展及其依赖必须提前构建，并能在加载时被解析。对于上面的三文件示例，入口为：

```js
// my-extension/index.mjs
import { keepParentDefinition } from './dist/proposer-keep-parent/index.js';

export function register(registry) {
  registry.registerOperation(keepParentDefinition);
}
```

| 注册 API                           | 用途                                                                 |
| ---------------------------------- | -------------------------------------------------------------------- |
| `registerOperation(definition)`    | 注册插件及其契约。返回注销函数；实现仍被使用时不能注销。             |
| `registerContract(contract)`       | 单独注册契约，供尚未绑定实现的 Policy 解析。相同 ID 的声明必须一致。 |
| `registerPolicy(id, absolutePath)` | 将 Policy ID 关联到完整的 Policy YAML 文件；文件顶层 `id` 必须一致。 |
| `catalog()`                        | 返回当前注册的 `plugins` 和 `policies` ID 数组。                     |

内置契约不能满足新能力时，可通过 `defineContract({ id, input_schema, output_schema })` 声明新契约，再让插件实现它，并在自定义 Policy 的 `require` 中使用它。读取该 Policy 前必须先注册契约或实现。共享内部工具作为普通模块复用，不单独注册为公共插件。

在声明了 `proposer` 的 Policy 中，通过默认绑定或 Recipe 的 `bindings.proposer.plugin: proposer.keep-parent` 选择该实现，并提供必需的 `config.reason`；需要扩展的命令都传入该目录：

```sh
ember-rsi validate ./my-recipe/recipe.yaml --plugin-dir ./my-extension
ember-rsi run ./my-recipe/recipe.yaml --id custom-run --plugin-dir ./my-extension
```

仓库内置扩展则需将定义加入 [registerBuiltins](../../../src/runtime/builtins.ts) 并重新构建。仅创建源码文件不会注册插件。

## 嵌入 Runtime

外部宿主可以直接注册定义。下面假定已准备好完整的 `policy.my-search` 文件和引用它的 Recipe；校验和执行使用同一个 Runtime：

```ts
import { resolve } from 'node:path';
import { createRuntime, validateRecipe } from 'ember-rsi';
import { keepParentDefinition } from './my-extension/dist/proposer-keep-parent/index.js';

const runtime = await createRuntime({
  rootDirectory: process.cwd(),
  homeDirectory: false,
});
try {
  runtime.registry.registerOperation(keepParentDefinition);
  runtime.registry.registerPolicy(
    'policy.my-search',
    resolve('./my-extension/policy.yaml'),
  );
  const recipePath = resolve('./my-recipe/recipe.yaml');
  const check = await validateRecipe(runtime, recipePath);
  console.log(check);
  const result = await runtime.manager.run(recipePath, { id: 'custom-run' });
  console.log(result.status, result.output);
} finally {
  await runtime.dispose();
}
```

### createRuntime 选项

全部选项均可省略，定义见 [Runtime 入口](../../../src/runtime/context.ts)。这些是宿主 API 参数，不是新增的 YAML Runtime 配置文件。

| 选项                                 | 默认与用途                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `rootDirectory`                      | 当前进程目录，作为宿主工作根目录。                                          |
| `directory`                          | 工作根目录下的 `.rsi/`，保存 Runtime 数据。                                 |
| `homeDirectory`                      | 默认 `~/.ember-rsi`；字符串可指定扩展主目录，`false` 禁用用户级扩展加载。   |
| `pluginDirectories`                  | 额外扩展目录数组，路径相对于当前进程目录；在用户级扩展之后加载。            |
| `context`                            | 提供宿主的 `RuntimeContext`，Runtime 在其上扩展能力。                       |
| `registry`                           | 提供 Registry；Runtime 仍会注册内置插件和 Policy，避免提前重复注册相同 ID。 |
| `artifacts` / `facts` / `workspaces` | 替换默认的本地存储和工作区服务。                                            |

### 检查装配后的对象

`Recipe`、`Policy`、`Binding` 的运行时类从 `ember-rsi` 导入。`Recipe.load(recipePath, registry)` 返回已装配定义，不初始化 Application、不创建运行实例、不调用模型。

| 对象    | 可读取的定义字段                                                                                                                                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recipe  | `schemaVersion`、`id`、`description`、`sourcePath`、`application`、`policy`、`policyConfig`、`policyInput`、`bindings`、`budget`、`reflection`。`policy` 是 Policy 对象，`policyInput` 在 Application 初始化后求值。                               |
| Binding | `name`、`definition`、`config`、`pluginId`。`pluginId` 来自实现的 `definition.id`，`config` 是最终配置。                                                                                                                                           |
| Policy  | `id`、`description`、`sourcePath`、`directory`、`inputSchema`、`configSchema`、`stateSchema`、`outputSchema`、`inputDefaults`、`stateInitial`、`requirements`、`defaults`、`steps`、`output`、`digest`。共享状态属于每次执行，不保存在定义对象上。 |

`Binding.resolve({ name, required, registry, defaults?, override? })` 负责装配；`defaults` 和 `override` 都包含 `declaration` 与来源 `directory`。`binding.withConfig(config)` 接收路径已准备好的完整配置，校验后返回新绑定，不合并旧配置，也不启用修订。启用归 Runtime。

`recipe.toJSON()` 导出可持久化声明，其中 `policy` 使用 `id/config/input`，绑定使用 `plugin/config`。`binding.toJSON()` 和 `policy.toJSON()` 也返回声明数据，定义字段按只读快照处理。不要将存活的 `RuntimeContext` 或工厂函数作为 JSON 持久化。

## 处理恢复和清理

Runtime 锁定实验使用的 Recipe、Policy、配置和声明资源。恢复未完成实验时读取锁定内容与已确认的修订，并校验已注册插件的实现指纹；指纹变化时拒绝恢复。宿主仍需加载对应扩展。插件的外部写入需有幂等条件或可核实的效果。

| 中断时已确认的内容                   | 恢复行为                               |
| ------------------------------------ | -------------------------------------- |
| 步骤结果已保存                       | 恢复结果和状态，不重复该步骤的副作用。 |
| 成功调用收据已保存，步骤结果尚未保存 | 复用成功收据，补全步骤记录。           |
| 调用已开始，但效果无法确认           | 停止自动恢复，先检查收据与外部效果。   |
| 调用尚未开始                         | 正常执行。                             |

清理失败与实验结果分开记录。`runtime.dispose()` 会报告失败或仍在等待的清理，Runtime 保留资源所有权，直到清理结束。宿主独立确认失败的外部资源已释放后，可调用 `runtime.manager.reconcileCleanup(experimentId)`，再执行 dispose。协调不会重复调用插件 dispose，也拒绝仍在等待的清理。

宿主进程直接注册插件，不会修改另行启动的 CLI 进程。请通过该宿主管理实验，或通过 `--plugin-dir` 加载相同扩展。更多操作见[运行与恢复实验](running-experiments_zh.md)。

完成实现后，先检查配置、契约不匹配和取消清理等必要边界，再用同一扩展执行 `validate` 和本地确定性运行。仓库工程检查使用现有 `pnpm check`；修改仓库源码后用 `pnpm build` 更新构建。真实模型或基准评测需要另行显式运行，配置校验和组件测试不代表优化已经生效。
