# Reflection 使用指南

[English](reflection.md) | 简体中文 · [快速入门](../getting-started_zh.md)

Reflection 为插件资源文件提出修订。Runtime 检查修改，激活通过校验的版本，并用修订后的配置创建插件实例。后续调用记录实际取得的修订版本。

## 在 Policy 和 Recipe 中启用或覆盖 Reflection

Policy 通过 `defaults.reflection` 设置默认行为，Recipe 通过 `reflection` 覆盖：

| 取值 | 行为 |
| --- | --- |
| 省略 | Recipe 沿用 Policy 的 `defaults.reflection`；若 Policy 也省略，则 Reflection 保持**关闭**。 |
| `false` | 关闭 Reflection。 |
| `true` | 启用 Reflection 并沿用 Policy 的 `defaults.reflection` 配置文件。如果 Policy 未提供配置文件，会在**加载时报错**（Reflection 必须声明 `targets.include`）。 |
| `{ configFile: <路径> }` | 加载一份声明了 `targets.include` 的完整 Reflection YAML 配置文件。路径相对于声明该字段的 Policy 或 Recipe 解析。Recipe 指定的配置文件会完整替换 Policy 文件。 |

### 内置 Policy 默认配置

六个内置 Agent Policy 都提供 Reflection 配置文件；Parameter Grid 和 Optuna 默认关闭 Reflection：

| Policy | 默认 Reflection 配置 |
| --- | --- |
| `policy.wikiskill` | 启用（`./reflection.yaml`）：`trigger: { on: loop-iteration }`，`evidence.view: training`，`excludeSteps: [baseline, baseline_score, validate, test]`，`targets.include: { proposer: '*' }`。 |
| `policy.gym-rsi` | 启用（`./reflection.yaml`）：`trigger: { on: loop-iteration }`，`evidence.view: training`，`excludeSteps: [baseline, baseline_score, validate, promotion]`，`targets.include: { proposer: '*' }`。 |
| `policy.harness2` | 启用（`./reflection.yaml`）：`trigger: { on: loop-iteration }`（每个任务结束后），`evidence.view: execution`（对评判结果盲测），`targets.include: { invariantProposer: '*', domainProposer: '*' }`，`budget: { timeoutSeconds: 3600 }`。 |
| `policy.gepa` | 启用（`./reflection.yaml`）：`trigger: { on: loop-iteration }`，`evidence.view: training`，`includeSteps: [proposal, proposal_evaluation]`，`targets.include: { proposer: '*' }`。 |
| `policy.parameter-agent` | 启用（`./reflection.yaml`）：`trigger: { on: loop-iteration }`，`evidence.view: training`，`targets.include: { proposer: '*' }`。 |
| `policy.operator-search` | 启用（`./reflection.yaml`）：`trigger: { on: loop-iteration }`，`evidence.view: training`，`targets.include: { proposer: [promptsDirectory], summarizer: [promptFile] }`。 |
| `policy.parameter-grid`、`policy.parameter-optuna` | 默认关闭（`defaults.reflection: false`）。 |

## 配置文件字段说明

Reflection YAML 配置文件必须声明 `targets.include`，其余字段均可选，不允许出现未声明字段。文件内的相对路径均相对于该配置文件所在目录解析。完整校验规则见[运行时演进 Schema](../../../src/contracts/runtime-evolution.ts)。

以下 Harness² 风格的配置授权两个 Proposer 各自的本地资源：

```yaml
trigger: { on: loop-iteration, every: 2 }
evidence: { view: execution }
targets:
  include:
    invariantProposer: '*'
    domainProposer: '*'
budget: { timeoutSeconds: 3600 }
```

### 顶层字段

| 字段 | 必填 | 类型 / 取值 | 默认值 | 用途 |
| --- | --- | --- | --- | --- |
| `targets` | **是** | 对象（`include` 必填，`exclude` 可选） | 无 | 指定授权 Reflection 修改的 Policy 绑定及其本地 `x-rsi-path` 资源字段。 |
| `trigger` | 否 | 对象 | `{ on: 'loop-iteration', every: 1 }` | 触发 Reflection 的串行 Policy 边界与频次。 |
| `evidence` | 否 | 对象 | `{ view: 'training' }` | 证据视图及每次反思窗口的绑定/步骤过滤条件。 |
| `goal` | 否 | 非空路径字符串 | 内置 [`reflection-agent/goals/generic/prompt.md`](../../../src/plugins/reflection-agent/goals/generic/prompt.md) | UTF-8 非空文本文件，说明 Reflection 应改进什么问题。 |
| `implementation` | 否 | 对象 | `reflection.agent`（`contract.reflection`） | 选择并配置负责生成修订提案的插件实现。 |
| `budget` | 否 | 对象 | `{}`（不额外限制） | 单次 Reflection 调用的资源上限（`modelCalls`、`timeoutSeconds`、`evidenceBytes`）。 |

### `targets` 字段

| 字段 | 必填 | 可选值 | 行为 |
| --- | --- | --- | --- |
| `targets.include` | **是** | 非空映射：`<绑定名>: '*' \| ['*'] \| string[]` | 授权修改所列 Policy 绑定上已配置的本地 `x-rsi-path` 资源。 |
| `targets.exclude` | 否 | 映射：`<绑定名>: '*' \| ['*'] \| string[]` | 从 `targets.include` 中移除整个绑定（`'*'` / `['*']`）或特定字段；最终必须保留至少一个可编辑资源。 |

单个绑定的字段选择语法：

- 用 `'*'` 或 `['*']` 选择该绑定已配置的全部本地 `x-rsi-path` 资源。对 `proposer.agent` 而言，涵盖主提示词 `prompt`、`messageTemplates`、`skills` 目录和 `subagents` 中的角色提示词。通配符会自动跳过远程 URL。若未匹配到任何本地路径，校验会报错。
- `[字段, ...]`（非空、无重复的字段名或以 `/` 开头的 JSON Pointer 列表，不能包含 `'*'`）：将权限缩小到具体 `x-rsi-path` 字段，例如 `proposer: [prompt]`、`proposer: [promptsDirectory]`、`summarizer: [promptFile]` 或 `proposer: ['/subagents/0/prompt']`。填写集合字段名（如 `skills` 或 `subagents`）会匹配其下全部已配置的 `x-rsi-path` 条目。显式列出未在插件 `configSchema` 中声明、未配置或指向远程 URL 的字段会在加载时报错。
- 每个选中的目标在磁盘上都必须是普通本地文件或目录（拒绝符号链接）。

**共享与嵌套资源。** 两个选中的字段引用同一文件时，Reflection 只编辑一份副本。选中的目录也覆盖其内部被选中的文件。如果通过符号链接访问项目，共享资源的字段应使用同一条项目路径。例如，提案器使用 `prompts/`，总结器使用 `prompts/summarize.md`。修改该文件会重新加载两个绑定，修改目录中的其他文件只会重新加载提案器。每次通过校验的更新只为实验生成一个联合修订版本，涵盖全部受影响的绑定。

### `trigger` 字段

| 字段 | 必填 | 可选值 | 默认值 | 行为 |
| --- | --- | --- | --- | --- |
| `trigger.on` | 否 | `'loop-iteration'` \| `'loop-end'` \| `'experiment-end'` \| `'after-step'` | `'loop-iteration'` | `loop-iteration`：顶层循环每轮结束时触发；若 Policy 无顶层循环，则在实验结束时触发。<br>`loop-end`：顶层循环结束时触发一次。<br>`experiment-end`：最后一个顶层步骤结束后、生成最终输出前触发一次。<br>`after-step`：匹配 `trigger.step` 的串行步骤结束后触发。 |
| `trigger.every` | 否 | `>= 1` 的整数 | `1` | 每匹配 *N* 次边界执行一次（如 `every: 2` 在第 2、4、6 等次匹配时执行）。 |
| `trigger.step` | 条件必填 | 非空步骤 ID 字符串 | 无 | 仅当 `trigger.on` 为 `'after-step'` 时必填，其他触发类型禁止填写。必须是 Policy 中位于并行 `foreach` 分支之外的串行步骤 ID。 |

Memory 和 Reflection 在同一边界同时命中时，先执行 Memory。

### `evidence` 字段

| 字段 | 必填 | 可选值 | 默认值 | 行为 |
| --- | --- | --- | --- | --- |
| `evidence.view` | 否 | `'training'` \| `'execution'` \| `'training-summary'` | `'training'` | `training`：同时提供 `context/evolution/training-summary.json` 中已授权的评分反馈、脱敏执行文件、调用记录、符合条件的子 Agent 诊断与工作区，以及本次更新产生的 Memory 快照（如有）。<br>`execution`：提供脱敏执行文件、调用记录、符合条件的子 Agent 诊断与工作区及 Memory 快照，屏蔽评分与判题反馈，适合对评判结果盲测。<br>`training-summary`：提供精简调用摘要、有界预览、已授权的评分反馈，对 Memory 仅保留更新回执（不含快照文本）。<br>详见 [Evidence](../concepts/architecture_zh.md#evidence)。 |
| `evidence.includeBindings` | 否 | 无重复的 Policy 绑定名和/或 `'memory'` 数组 | 全部 Policy 绑定；Memory 启用时另含 `'memory'` | 仅观察指定绑定的主调用。显式填写 `'memory'` 要求启用 Memory。 |
| `evidence.excludeBindings` | 否 | 无重复的 Policy 绑定名和/或 `'memory'` 数组 | 无 | 排除指定绑定的调用。即使 Recipe 关闭了 Memory，共用的 Reflection 配置文件仍可在 `excludeBindings` 中列出 `'memory'`。 |
| `evidence.includeSteps` | 否 | 无重复的 Policy 步骤 ID 数组 | 全部 Policy 步骤 | 仅观察指定步骤内的 Policy 调用（不作用于 Memory 更新回执）。 |
| `evidence.excludeSteps` | 否 | 无重复的 Policy 步骤 ID 数组 | 无 | 排除指定步骤内的 Policy 调用（例如留出的验证集或测试集步骤）。 |

**Memory 快照隔离。** 观察 `memory` 绑定时，`training` 和 `execution` 视图会提供本次更新产生的 Memory 快照（如有），其中可能保留 Memory 自身证据窗口中的观察结果。需要隔离留出集时，应让两者的过滤范围一致，或在 Reflection 中设置 `excludeBindings: [memory]`。证据窗口为空时跳过本次生成。

### `implementation` 字段

| 字段 | 必填 | 可选值 | 默认值 | 行为 |
| --- | --- | --- | --- | --- |
| `implementation.contract` | 否 | `'contract.reflection'` | `'contract.reflection'` | 所选插件必须遵循的公共契约。 |
| `implementation.ref` | 否 | 已注册的插件 ID | `'reflection.agent'` | 实现 `contract.reflection` 的插件。 |
| `implementation.config` | 否 | 插件配置对象 | `{}` | 传给所选插件的配置，按其 `configSchema` 校验（内置 `reflection.agent` 支持的字段见下表）。 |

内置 `reflection.agent` 在 `implementation.config` 下支持以下字段（见[共享编辑 Schema](../../../src/plugins/shared/agent-editing/schema.ts)），并内置 `reflection-reviewer` 子 Agent 用于委派聚焦证据核查：

| 字段 | 必填 | 可选值 | 默认值 | 行为 |
| --- | --- | --- | --- | --- |
| `implementation.config.agentRef` | 否 | Policy 已声明的 `contract.agent` 绑定名 | 唯一 `contract.agent` 绑定，否则 `_evolutionAgent` | 指定执行 Reflection 的 Agent。省略时复用 Policy 声明的唯一 `contract.agent` 绑定；若 Policy 未声明或声明了多个这类绑定，Runtime 会用内置 `agent.pi` 创建 `_evolutionAgent`（读取 `MODEL_NAME`、`MODEL_ENDPOINT` 和 `MODEL_API_KEY`）。 |
| `implementation.config.prompt` | 否 | 非空文件路径字符串 | 内置 [`reflection-agent/prompt.md`](../../../src/plugins/reflection-agent/prompt.md) | 自定义提示词文件，指导 Reflection 如何分析证据并修改目标资源。 |
| `implementation.config.messageTemplates.default` | 否 | 本地 Markdown 文件路径 | 内置任务正文 | 用 [Agent 模板变量](configuration_zh.md#agent-任务正文) 自定义任务正文。路径相对于模块配置文件。 |
| `implementation.config.skills` | 否 | 目录路径字符串数组 | `[]` | 本地 Skill 目录列表，会复制到 Reflection Agent 工作区的 `.agents/skills/` 中。 |

### `budget` 字段

| 字段 | 必填 | 可选值 | 默认值 | 行为 |
| --- | --- | --- | --- | --- |
| `budget.modelCalls` | 否 | `>= 0` 的整数 | 无局部上限 | 单次 Reflection 调用允许的新增模型请求上限；`0` 阻止新增模型请求。 |
| `budget.timeoutSeconds` | 否 | `1`–`2147483` 的整数 | 无局部上限 | 单次 Reflection 调用的墙钟时长上限（秒）。 |
| `budget.evidenceBytes` | 否 | `>= 1` 的整数 | 无模块级上限 | 单次证据投影的最大字节数。 |

Recipe 的实验级预算及 Agent 后端自身的超时设置仍会同时生效，见[限制与预算](configuration_zh.md#限制与预算)。

## 自定义插件如何接入 Reflection

如需让 Reflection 修订自定义插件的资源：

1. 在插件的 `configSchema` 中用 `'x-rsi-path': 'file'` 或 `'x-rsi-path': 'directory'` 标记可编辑的文件或目录字段（参见 [`configSchema`](writing-plugins_zh.md#configschema)）。
2. 在 Policy 或 Recipe 中为该绑定配置本地文件或目录路径，并在 `reflection.yaml` 的 `targets.include` 中授权对应字段。
3. 在 `create(config, context)` 中读取 Runtime 传入的修订后 `config` 路径，使已激活的修订在后续调用中生效。

## 执行结果与持久化

| 状态 | 含义 |
| --- | --- |
| `activated` | 校验通过的修改已保存为联合修订、物化到 `.rsi/experiments/<experiment-id>/revisions/<revision-id>/resources/`，并为所有受影响的绑定（`changedBindings`）激活。 |
| `no-change` | 生成器未提出实质改动，继续沿用当前活动修订。 |
| `skipped` | 当前证据窗口没有可用观察，跳过本次调用。 |
| `rejected` | 生成器失败、触及局部超时或提出了非法修改（如修改 `targets` 之外的路径、删除文件、变更文件权限或写入非 UTF-8 内容）。当前活动修订保持不变，实验继续运行。 |

实验取消、实验级预算耗尽和关键持久化失败仍会停止实验。记录保存在 `.rsi/facts/`（`revisions`、`activations`、`evolution-runs`）与 `.rsi/artifacts/` 下。

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
