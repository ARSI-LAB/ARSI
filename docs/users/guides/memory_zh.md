# Memory 使用指南

[English](memory.md) | 简体中文 · [快速入门](../getting-started_zh.md)

Memory 通过带版本的非可执行 UTF-8 文本目录保存可复用经验。实验启动时对配置的目录建立快照，目录不存在或未配置时从空树开始。每次成功更新会激活新的不可变版本。恢复实验时会重新使用其活动版本。

## 在 Policy 和 Recipe 中启用或覆盖 Memory

Memory 默认启用。Policy 通过 `defaults.memory` 设置默认行为，Recipe 通过 `memory` 覆盖：

| 取值 | 行为 |
| --- | --- |
| 省略 | Recipe 沿用 Policy 的 `defaults.memory`；若 Policy 也省略，则按内置默认值启用。 |
| `false` | 关闭 Memory。 |
| `true` | 启用 Memory；若 Policy 声明了 `defaults.memory` 配置文件则沿用该文件，否则使用内置默认值。 |
| `{ configFile: <路径> }` | 加载一份完整的 Memory YAML 配置文件。路径相对于声明该字段的 Policy 或 Recipe 解析。Recipe 指定的配置文件会完整替换 Policy 文件，文件中省略的字段取内置默认值。 |

### 内置 Policy 默认配置

| Policy | 默认 Memory 配置 |
| --- | --- |
| `policy.wikiskill` | 启用（`./memory.yaml`）：`trigger: { on: after-step, step: train }`，`evidence.view: training`，`excludeSteps: [baseline, baseline_score, validate, test]`，使用专用 `memory.md` 提示词。 |
| `policy.gym-rsi` | 启用（`./memory.yaml`）：`trigger: { on: after-step, step: train }`，`evidence.view: training`，`excludeSteps: [baseline, baseline_score, validate, promotion]`，复用 WikiSkill 的 `memory.md` 提示词。 |
| `policy.harness2` | 启用（`./memory.yaml`）：`trigger: { on: loop-iteration }`（每个任务结束后），`evidence.view: execution`（对评判结果盲测），`targets.exclude: [selector]`，使用专用 `memory.md` 提示词。 |
| `policy.gepa` | 启用（`./memory.yaml`）：`trigger: { on: loop-iteration }`，`evidence.view: training`，`includeSteps: [proposal, proposal_evaluation]`。 |
| `policy.parameter-agent`、`policy.operator-search` | 按内置默认值启用（`loop-iteration`、`evidence.view: training`、覆盖全部 Policy 绑定）。 |
| `policy.parameter-grid`、`policy.parameter-optuna` | 默认关闭（`defaults.memory: false`）。 |

## 配置文件字段说明

Memory YAML 配置文件中的所有字段均为可选，不允许出现未声明字段。文件内的相对路径均相对于该配置文件所在目录解析。完整校验规则见[运行时演进 Schema](../../../src/contracts/runtime-evolution.ts)。

例如，WikiSkill Recipe 需要带有界执行预览的精简反馈时，可通过 `memory: { configFile: ./wiki-memory.yaml }` 选择以下配置：

```yaml
directory: ./wiki
trigger: { on: after-step, step: train }
evidence:
  view: training-summary
  excludeSteps: [baseline, baseline_score, validate, test]
targets: { include: [proposer] }
budget:
  modelCalls: 12
  timeoutSeconds: 600
```

### 顶层字段

| 字段 | 必填 | 类型 / 取值 | 默认值 | 用途 |
| --- | --- | --- | --- | --- |
| `directory` | 否 | 非空路径字符串 | 省略（从空树开始） | 实验启动时快照的种子目录，也是 `arsi memory show/apply` 的默认写回目标。必须是用户自有的专用目录（不能含符号链接、目录联接，不能位于 `.rsi/`、`.git/` 等受保护路径下，也不能是整个项目目录或文件系统根目录）。磁盘上目录尚不存在时从空树开始。 |
| `trigger` | 否 | 对象 | `{ on: 'loop-iteration', every: 1 }` | 触发 Memory 更新的串行 Policy 边界与频次。 |
| `evidence` | 否 | 对象 | `{ view: 'training' }` | 证据视图及每次更新窗口的绑定/步骤过滤条件。 |
| `targets` | 否 | 对象 | 全部 Policy 绑定 | 哪些调用方绑定在调用 `ctx.invokeAgent` 时挂载 Memory 快照。 |
| `goal` | 否 | 非空路径字符串 | 内置 [`memory-agent/goal.md`](../../../src/plugins/memory-agent/goal.md) | UTF-8 非空文本文件，说明本次需要整理什么经验。 |
| `implementation` | 否 | 对象 | `memory.agent`（`contract.memory`） | 选择并配置负责更新 Memory 的插件实现。 |
| `budget` | 否 | 对象 | `{}`（不额外限制） | 单次 Memory 调用的资源上限（`modelCalls`、`timeoutSeconds`、`evidenceBytes`）。 |

### `trigger` 字段

| 字段 | 必填 | 可选值 | 默认值 | 行为 |
| --- | --- | --- | --- | --- |
| `trigger.on` | 否 | `'loop-iteration'` \| `'loop-end'` \| `'experiment-end'` \| `'after-step'` | `'loop-iteration'` | `loop-iteration`：顶层循环每轮结束时触发；若 Policy 无顶层循环，则在实验结束时触发。<br>`loop-end`：顶层循环结束时触发一次。<br>`experiment-end`：最后一个顶层步骤结束后、生成最终输出前触发一次。<br>`after-step`：匹配 `trigger.step` 的串行步骤结束后触发。 |
| `trigger.every` | 否 | `>= 1` 的整数 | `1` | 每匹配 *N* 次边界执行一次（如 `every: 2` 在第 2、4、6 等次匹配时执行）。 |
| `trigger.step` | 条件必填 | 非空步骤 ID 字符串 | 无 | 仅当 `trigger.on` 为 `'after-step'` 时必填，其他触发类型禁止填写。必须是 Policy 中位于并行 `foreach` 分支之外的串行步骤 ID。 |

Memory 和 Reflection 分别维护独立的证据窗口和命中计数；在同一边界同时命中时，先执行 Memory。

### `evidence` 字段

| 字段 | 必填 | 可选值 | 默认值 | 行为 |
| --- | --- | --- | --- | --- |
| `evidence.view` | 否 | `'training'` \| `'execution'` \| `'training-summary'` | `'training'` | `training`：在 `context/evolution/training-summary.json` 中提供已授权的指标及判题反馈，并通过 `context/evolution/packets/index.json` 和 `context/evolution/evaluation-index.json` 提供证据预算内的完整脱敏执行记录与文件。<br>`execution`：仅提供完整脱敏执行记录与文件，屏蔽评分及判题反馈，适合对评判结果盲测。<br>`training-summary`：提供精简调用摘要、有界执行预览以及已授权的评分反馈。<br>详见 [Evidence](../concepts/architecture_zh.md#evidence)。 |
| `evidence.includeBindings` | 否 | 无重复的 Policy 绑定名数组 | 全部 Policy 绑定 | 仅观察 `require` 中列出的指定绑定的主调用。 |
| `evidence.excludeBindings` | 否 | 无重复的 Policy 绑定名数组 | 无 | 排除指定绑定及其产生的测量结果。 |
| `evidence.includeSteps` | 否 | 无重复的 Policy 步骤 ID 数组 | 全部 Policy 步骤 | 仅观察指定步骤内的 Policy 调用。 |
| `evidence.excludeSteps` | 否 | 无重复的 Policy 步骤 ID 数组 | 无 | 排除指定步骤内的 Policy 调用（例如留出的验证集或测试集步骤）。 |

Runtime 在每个窗口内汇总调用记录、测量投影、候选差异和选择决策。窗口内没有可用观察时会跳过本次生成。

### `targets` 字段

| 字段 | 必填 | 可选值 | 默认值 | 行为 |
| --- | --- | --- | --- | --- |
| `targets.include` | 否 | 无重复的 Policy 绑定名数组 | 全部 Policy 绑定 | 允许在调用 `ctx.invokeAgent` 时挂载 `context/memory/` 的调用方绑定名。 |
| `targets.exclude` | 否 | 无重复的 Policy 绑定名数组 | 无 | 从可读取 Memory 的绑定集合中排除指定绑定。内置 Memory 和 Reflection 生成器始终被排除。 |

### `implementation` 字段

| 字段 | 必填 | 可选值 | 默认值 | 行为 |
| --- | --- | --- | --- | --- |
| `implementation.contract` | 否 | `'contract.memory'` | `'contract.memory'` | 所选插件必须遵循的公共契约。 |
| `implementation.ref` | 否 | 已注册的插件 ID | `'memory.agent'` | 实现 `contract.memory` 的插件。 |
| `implementation.config` | 否 | 插件配置对象 | `{}` | 传给所选插件的配置，按其 `configSchema` 校验（内置 `memory.agent` 支持的字段见下表）。 |

内置 `memory.agent` 在 `implementation.config` 下支持以下字段（见[共享编辑 Schema](../../../src/plugins/shared/agent-editing/schema.ts)）：

| 字段 | 必填 | 可选值 | 默认值 | 行为 |
| --- | --- | --- | --- | --- |
| `implementation.config.agentRef` | 否 | Policy 已声明的 `contract.agent` 绑定名 | 唯一 `contract.agent` 绑定，否则 `_evolutionAgent` | 指定执行 Memory 的 Agent。省略时复用 Policy 声明的唯一 `contract.agent` 绑定；若 Policy 未声明或声明了多个这类绑定，Runtime 会创建 `_evolutionAgent`，使用内置 `agent.pi` 并读取 `MODEL_NAME`、`MODEL_ENDPOINT` 和 `MODEL_API_KEY`。 |
| `implementation.config.prompt` | 否 | 非空文件路径字符串 | 内置 [`memory-agent/prompt.md`](../../../src/plugins/memory-agent/prompt.md) | 自定义提示词文件，指导 Memory 如何组织和编辑经验文档。 |
| `implementation.config.skills` | 否 | 目录路径字符串数组 | `[]` | 本地 Skill 目录列表，会复制到 Memory Agent 工作区的 `.agents/skills/` 中。 |

### `budget` 字段

| 字段 | 必填 | 可选值 | 默认值 | 行为 |
| --- | --- | --- | --- | --- |
| `budget.modelCalls` | 否 | `>= 0` 的整数 | 无局部上限 | 单次 Memory 调用允许的新增模型请求上限；`0` 阻止新增模型请求。 |
| `budget.timeoutSeconds` | 否 | `1`–`2147483` 的整数 | 无局部上限 | 单次 Memory 调用的墙钟时长上限（秒）。 |
| `budget.evidenceBytes` | 否 | `>= 1` 的整数 | 无模块级上限 | 单次证据投影的最大字节数。 |

Recipe 的实验级预算及 Agent 后端自身的超时设置仍会同时生效，见[限制与预算](configuration_zh.md#限制与预算)。

## 在 Agent 调用中读取 Memory

符合条件的绑定调用 `ctx.invokeAgent` 时，Runtime 在调用方项目的派生副本中，将本次调用固定的非空快照以只读方式挂载到 `context/memory/`。`AGENTS.md` 和 `CLAUDE.md` 会列出这些只读文件，Agent 调用回执的 `metadata.memoryVersionRef` 记录所用的版本。

## 执行结果与持久化

| 状态 | 含义 |
| --- | --- |
| `activated` | 校验通过的 UTF-8 文件修改已保存为新的不可变版本，并对后续调用生效。 |
| `no-change` | 生成器未提出实质改动，继续沿用先前的活动快照。 |
| `skipped` | 当前证据窗口没有可用观察，跳过本次调用。 |
| `rejected` | 生成器失败、触及局部超时或提出了非法修改（如二进制文件、可执行权限、受保护路径）。先前的活动快照保持不变，实验继续运行。 |

实验取消、实验级预算耗尽和关键持久化失败仍会停止实验。快照与记录保存在 `.rsi/artifacts/` 与 `.rsi/facts/`（`memory-revisions`、`evolution-runs`）下。

## 为后续实验保留经验

```sh
arsi memory list my-experiment
arsi memory show <versionID> --to ./exported-wiki
arsi memory apply <versionID> --to ./exported-wiki
```

若已配置 `directory`，预览和应用默认使用记录的目录。零配置实验可用 `--to` 指定目的地。应用整份快照前应核对将新增、替换和移除的文件。工作台 **Reflection & Memory → Memory** 提供相同的预览和确认流程。写回需要专用的用户目录，且当前存储内所有实验均已结束、状态可确认。后续实验可通过配置该目录复用经验。

有关插件自有资源的修订，见 [Reflection](reflection_zh.md)。
