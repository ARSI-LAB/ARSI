# 配置实验

[English](configuration.md) | 简体中文 · [快速入门](../getting-started_zh.md)

本指南介绍实验的配置方式，包括 Recipe 字段、Agent 后端与环境变量、指标选择，以及各层限制和预算的生效规则。

## Recipe 字段与绑定覆盖

Recipe 包含以下顶层字段，完整 Recipe 示例见[快速入门](../getting-started_zh.md#2-编写-recipe-并选择内置-policy)：

| 字段            | 必填 | 职责                                     | 填写方式                                                                                                                                                                     |
| --------------- | ---- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | 是   | 指定 Recipe 的格式版本。                 | 填写 Recipe 所使用的协议版本标识，如 `rsi.recipe/v1`（当前仅支持此版本）。                                                                                                   |
| `id`            | 是   | 为这份实验配置命名。                     | 如 `my-terminal-skills`；某次运行的实验 ID 可通过 CLI 的 `--id` 指定。                                                                                                       |
| `description`   | 否   | 说明这份配置的用途。                     | 填写一段说明文字。                                                                                                                                                           |
| `application`   | 是   | 指定优化对象及其管理方式。               | `plugin` 填 Application ID，如 `application.agentbundle`；`config` 填该实现需要的参数，如 `target`、`baseline`。 详见 [Application](built-in-components_zh.md#application)。 |
| `policy`        | 是   | 选择实验流程，并提供流程参数和初始数据。 | `id` 填 Policy ID，如 `policy.wikiskill`；`config` 填Policy规定需要的参数值，如轮数、数据集等；`input` 填Policy规定需要的输入数据，如初始候选等。                            |
| `bindings`      | 否   | 指定流程中各动作使用的插件与配置。       | 键名与所选 Policy 的 `require` 一致。Policy 按这些名称使用插件，Recipe 通过对应条目的 `plugin` 和 `config` 指定具体实现与参数。                                              |
| `budget`        | 否   | 设置实验的调用次数、运行时长等上限。     | 如 `evaluationRuns: 20`、`elapsedWallMs: 21600000`；详细字段见[限制与预算](#限制与预算)。                                                                                    |
| `reflection`    | 否   | 替换 Policy 默认的 Reflection 配置。     | 填写配置对象，通过 `configFile` 指定 Reflection 配置文件路径，如 `{ configFile: ./reflection.yaml }`，其遵循独立的 [声明与调用规则](reflection_zh.md#通过-recipe-替换文件)。 |

- Recipe 中的 `config` 用来配置所选的 Application、Policy 或插件，具体字段和填写要求由各自的配置 Schema 定义。
  - 填写时可以沿用 Schema 默认值，插件绑定还可继承 Policy 的默认配置；
  - 在此基础上补齐仍缺少的必填参数，并按需调整其他设置。

- `application.plugin`、`policy.id` 和 `bindings.<name>.plugin` 均填写已注册的 ID。
  - 例如，Policy 的评测步骤使用 `use: evaluator`，Recipe 就通过 `bindings.evaluator` 指定该步骤使用的 Evaluator 插件与配置。
- Recipe 绑定覆盖 Policy 的 `defaults.bindings`：
  - Policy 已提供默认输入时，可省略对应字段。省略 `plugin` 时继承默认实现。
  - Recipe 和 Policy沿用同一实现时，普通对象递归合并；数组、标量和 null 替换原值。
  - Policy 未提供默认绑定的动作，Recipe 需要在 `bindings` 中补齐。

## Agent 与环境变量

分别配置优化流程使用的 Agent 和被测系统使用的 Evaluator，两者的模型设置互不替代。Agent 可选 Pi（在 Recipe 中配置模型服务）或 Codex、Claude Code、DSH（使用已安装的 CLI）。

### 环境变量

RSI 不会自动加载 `.env` 文件，需要在启动 CLI 的进程中导出变量。原生 Agent CLI 仍可能按自身规则加载配置或环境文件。

- **模型环境变量由具体组件及其配置决定，框架没有一组统一必填的模型环境变量。**

### Evaluator

Evaluator 插件使用已安装的 Evaluator SDK 的配置类型和解析器。RSI 绑定候选实例、选定任务和本次调用的输出目录，将 SDK 解析后的配置写入文件，再扣除评测预算。凭据使用环境变量引用。SDK 在评测启动时应用默认值并校验 benchmark 专属参数，此时出错会消耗一次 `evaluationRuns` 预算。

`evaluator.agentbench` 的 `services` 配置被测 Agent 在基准任务中使用的模型服务，与优化流程中的 `agent` 绑定分别配置。下面以 TerminalBench 4.0 为例：

```yaml
# Recipe excerpt
bindings:
  evaluator:
    plugin: evaluator.agentbench
    config:
      services:
        default:
          model: ${EVALUATOR_MODEL_NAME}
          base_url: ${MODEL_ENDPOINT}
          api_key: ${MODEL_API_KEY}
      benchmark:
        name: terminalbench
        version: '4.0'
```

`services.default` 中的 `model`、`base_url` 和 `api_key` 分别指定模型名称、服务地址和凭据环境变量引用。

AgentBench 将候选 Bundle 绑定到 `agentbundle` solver，并用 Policy 指定的任务 ID 替换采样、偏移及任务数量限制。

如果优化器需要任务的公开提示词，可在 Evaluator 配置中设置 `run.includeTaskAnswer: true`，使 SDK 保存任务数据。RSI 将其中的公开提示词作为 `task-input` 执行证据提供给后续插件，参考答案仍保留在私有原生记录中。

InferenceBench 在本地通过 SDK 运行 AgentX 或 AISBench。AISBench solver 通过 SSH 连接负载生成器。省略 `services` 时，候选实例绑定到默认服务。如果通过 `benchmark.solver.service` 指定了其他服务名，Recipe 需要声明对应的服务条目。该条目可以配置 `retry`、`contextWindow` 等 SDK 选项。显式填写 `model`、`base_url` 或 `api_key` 都会报错。凭据引用在 Application 的 `credentials.apiKeyEnv` 中配置。其余服务条目按 SDK 要求填写。

OperatorBench 使用 SDK 的 `kernel` benchmark 和 RSI 的 `task.directory`。选定 case 后，RSI 会在获取候选实例前生成并校验本次评测的完整 SDK 配置。kernel replay 所需的服务由 RSI 提供。Recipe 必须省略整个 `services` 字段，填写空对象也会报错。`repeat`、`python`、`profiling` 等算子参数直接写在 `benchmark.config` 下。RSI 用候选源码和参考实现生成清单，绑定选定的 case 和 seed，并在调用目录内保存索引和结果。执行 `profile` 时会开启采集并禁用缓存。迁移已有 Recipe 时，将 `protocol` 和 `sdk` 中的算子参数移到 `benchmark.config`，删除 `mode` 和 `protocol.timingScope`。要保留原有运行设置，请配置 `run.onError: abort`，并将 `run.timeoutSeconds` 设为原算子超时加 30 秒。参见[算子 Recipe](../../../examples/artifacts/kernel/transpose-copy/recipe.search.yaml)。

### Pi 后端

`agent.pi` 通过 Pi 执行优化流程中的 Agent 任务，适合直接指定模型服务地址、模型名称和凭据。

对声明了 `agent` 绑定的 Policy，下面的片段显式配置请求和整次调用期限：

```yaml
bindings:
  agent:
    plugin: agent.pi
    config:
      model: ${MODEL_NAME}
      base_url: ${MODEL_ENDPOINT}
      api_key: ${MODEL_API_KEY}
      thinkingLevel: low
      timeoutMs: 1800000
      executionTimeoutMs: 3600000
```

[Pi Schema](../../../src/plugins/agent-pi/schema.ts) 的默认值为 `thinkingLevel: low`、`contextWindow: 262144`、`retries: 0`。通过 `maxTokens` 设置单次请求的输出上限，取值须适配 `contextWindow` 和端点能力。

- `api_key` 必须是环境变量引用，不能直接填写密钥。

- `timeoutMs` 限制每次模型请求，省略 `timeoutMs` 时底层 HTTP 客户端使用十分钟请求超时。两个字段都接受 1 到 2,147,483,647 的整数毫秒。
- `executionTimeoutMs` 限制整个 Agent 调用，包括模型请求、工具、输出纠正、上下文压缩、重试等待和等待中的子 Agent，不会在每次请求后重置。

### 原生 CLI 后端：Codex、Claude Code 和 DSH

先在运行 RSI 的电脑上安装 CLI，并完成登录或 API 配置。RSI 会调用这个 CLI，沿用它的模型和认证配置。

| 后端 | 命令 | 模型配置位置 | Recipe 可选设置 |
| --- | --- | --- | --- |
| `agent.codex` | `codex` | `~/.codex/config.toml` 和原生登录 | `model`、`thinkingLevel` |
| `agent.claudecode` | `claude` | 原生登录或网关环境变量 | `model`、`effort` |
| `agent.dsh` | `dsh` | `$DSH_HOME/profiles/headless`（默认 `~/.dsh/profiles/headless`） | 无 |

在 Recipe 中选择后端。下面使用 DSH；换成 Codex 或 Claude Code 时，只需修改 `plugin`：

```yaml
bindings:
  agent:
    plugin: agent.dsh
    config:
      timeoutMs: 180000
```

`timeoutMs: 180000` 表示一次 Agent 任务最多运行 3 分钟；不需要限制时可改成 `config: {}`。如果 RSI 找不到 CLI，可在 `config` 中用 `executable` 指定完整路径。Codex 和 Claude Code 还可以添加表中的模型选项。

安装 DSH：

```sh
npm install -g @deepseek-ai/dsh
```

DSH 需要配置 **headless** profile 的模型服务；只配置 Web 界面还不够。模型和密钥放在 DSH 配置或环境变量中，不要在 Recipe 中填写 `model`、`base_url` 或 `api_key`。

启动前检查 Recipe：

```sh
ember-rsi doctor path/to/recipe.yaml
ember-rsi run path/to/recipe.yaml
```

结果说明见 [Doctor](doctor_zh.md)。Claude Code 检查 CLI 兼容性和认证状态；DSH 检查 CLI 兼容性及 headless 配置组合。`model-access: unchecked` 表示仍需确认模型访问可用。

- Agent 读取任务文件并返回修改建议，由 RSI 检查后写入。
- Claude Code 禁用用户/项目设置、普通 Hooks 和 MCP；认证使用原生登录或启动环境变量。
- 在 Proposer 等调用组件中配置提示词和 Skills。
- 这些后端不能按 `budget.modelCalls` 限制模型请求次数；请用 `timeoutMs` 或实验时长预算控制运行时间。

## 推理优化

推理优化可用 `evaluator.inferencebench` 的 `benchmark.name: aisbench` 和内置 SSH Solver，也可选择 `agentx` 及其回放 Solver。基线和候选使用相同的评测负载。Runtime 统一执行 Recipe 的 `budget` 所定义的实验级上限。

对于 `parameter.agent`，`policy.config.candidatesPerRound` 默认为 4，可设为 1 至 6。调优 Proposer 基于同一个当前最优版本生成候选，按优先级排序，每批最多返回该数量。Policy 按顺序直接调用 `evaluator.inferencebench`，再用更新后的当前最优版本生成下一批。`maxTrials` 限制所有批次的候选尝试总数。已确认且完成清理的启动失败记为失败 Measurement，并拒绝该候选；SDK 评测失败、取消、收集不完整或清理状态不明会停止实验。失败基线不能启动搜索。

默认的 `selector.inference` 用 `metric` 和 `direction` 定义主优化指标，用 `constraints` 定义性能目标，并可通过 `eligibility` 指定硬性要求。它允许在全部达标前接受约束违反程度减小的候选，同时防止已满足的约束退步。选择规则见[内置组件](built-in-components_zh.md#loop-组件)。Policy 保留当前最优版本，并用 `candidateFeasible` 单独报告是否达标，不将其等同于候选是否被接受。

设置 `application.inference.config.remote.discoverParameters: true` 后，启动器会在初始化时报告当前安装版本的参数目录。Agent 可在 `context/input.json` 的 `target.parameterCatalog` 中读取。vLLM Ascend 示例已启用此功能，并将目录限制为明确列出的性能参数；精度、量化、投机解码和结构化配置均不开放。

## Proposer 文件编辑

`proposer.agent` 使用一套 Agent 输出 Schema。`edits` 中的每一项都有路径和 `op`。`replace` 和 `create` 提供完整的 `content`，`patch` 在 `changes` 中提供精确的 `oldText` 和 `newText`，`delete` 只需提供路径。同一个提案可以对不同路径使用不同操作。Proposer 和 Application 会执行编辑约束和 Target 权限检查。

如果路径使用了 `patch`，该路径只能有一条操作。同一路径上的多条整文件编辑仍按现有规则合并和处理冲突。

迁移自定义 Proposer prompt 时，从绑定配置删除 `editProtocol`，并为每条 edit 添加 `op`。整文件编辑中，已有文件用 `replace`，新文件用 `create`，删除用 `delete`。已有的带 `op` 的 patch 操作保留原有字段。

## 限制与预算

实验预算耗尽时，Runtime 会记录 `stopReason: budget-exhausted`，并用 `budgetMetric` 标明触及的上限。使用 `ember-rsi show <experiment-id>` 查看记录。如果能用最近一次已保存的检查点计算并验证 Policy 输出，记录还会包含 `partialOutput`。对于 `parameter.agent`，部分结果会保留已有的当前最优候选和测量，即使 `candidateFeasible` 为 false。实际停止原因以实验记录顶层的 `stopReason` 为准。

Recipe 中省略的绑定配置会先继承 Policy 默认值。下表的“缺省时”指对应配置最终仍未设置该项的情况；其他层的限制仍可能生效。

| 位置                                                  | 配置项                                            | 含义                                                                                                      | 缺省时                                                                            |
| ----------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Recipe                                                | `budget.operations`                               | Runtime 操作调用总数上限，包含嵌套调用。                                                                  | 无实验级次数上限。                                                                |
| Recipe                                                | `budget.evaluationRuns`                           | 评测调用总数上限；一次调用可包含多个任务，OperatorBench 的评测和性能分析调用均计入。                      | 无实验级评测次数上限。                                                            |
| Recipe                                                | `budget.modelCalls`                               | 支持计量的后端实际模型请求总数上限，包含重试、输出纠正和子 Agent；不限制基准 Solver 或原生 Codex、Claude Code 或 DSH 请求。   | 无实验级模型调用次数上限。                                                        |
| Recipe                                                | `budget.elapsedWallMs`                            | 整个实验的经过时间上限，单位毫秒；恢复时包含中断期间，不会重新计时。                                      | 无实验级运行时长上限。                                                            |
| Recipe                                                | `budget.cleanupReserveMs`                         | 释放实例、关闭插件等清理工作的时长上限，单位毫秒，单独计时。                                              | 无 Runtime 清理期限。                                                             |
| Pi                                                    | `maxTokens`                                       | 单次模型请求的最大输出 Token 数。                                                                         | 不发送输出 Token 上限，由模型服务决定。                                           |
| Pi                                                    | `contextWindow`                                   | Pi 用于上下文管理的窗口大小，单位 Token，应与模型能力匹配。                                               | 262144 Token。                                                                    |
| Pi                                                    | `timeoutMs`                                       | 单次模型请求的时长上限，单位毫秒。                                                                        | 底层 HTTP 客户端使用 600000 毫秒（10 分钟）。                                     |
| Pi                                                    | `executionTimeoutMs`                              | 完整 Agent 调用的时长上限，单位毫秒，包含请求、工具、压缩、重试等待和子 Agent。                           | 无整次调用的独立时长上限。                                                        |
| Codex / Claude Code / DSH                             | `timeoutMs`                                       | 完整 Agent 调用的时长上限，单位毫秒。                                                                     | RSI 不为该调用设置独立超时。                                                      |
| Operator Proposer                                     | `modelRequestTimeoutMs`                           | 一个完整模型阶段的共享时长上限，单位毫秒，包含工具续调与子 Agent。                                        | 120000 毫秒（2 分钟）。                                                           |
| AgentBench Evaluator                                  | `services.<service>.maxTokens`                    | 被测 Agent 所用模型服务的每轮输出 Token 上限。                                                            | 由 Solver 或模型服务的默认设置决定。                                              |
| AgentBench / InferenceBench Evaluator                 | `run.timeoutSeconds`                              | 单个基准任务一次执行的时长上限，单位秒。                                                                  | 使用 SDK 基准 profile 的值；profile 未指定时为 7200 秒（2 小时）。                |
| OperatorBench Evaluator                               | `benchmark.config.timeoutSeconds`                 | 单次算子评测或性能分析的时长上限，单位秒。                                                                | 默认 300 秒。启用性能分析时为 `maxAttempts × attemptTimeoutSeconds + 300` 秒。    |
| OperatorBench Evaluator                               | `benchmark.config.profiling.attemptTimeoutSeconds` | 一次性能分析尝试的时长上限，单位秒。                                                                      | SDK 默认 300 秒（5 分钟）。                                                       |
| Inference Application                                 | `remote.timeoutMs`                                | 一次远端脚本调用的时长上限，单位毫秒。                                                                    | 无远端调用的独立时长上限。                                                        |
| Inference Application                                 | `healthcheck.timeoutMs`                           | 等待推理服务就绪的时长上限，单位毫秒。                                                                    | 远端模式继承 `remote.timeoutMs`；该值也未设置或使用本地模式时，不设就绪等待上限。 |
| Pareto 演化提案器 | `maxRounds` | 逻辑尝试轮数上限，包含无修改和被拒绝的尝试。 | 必填，无默认值。 |
| Pareto 演化提案器 | `maxRollouts` | 初始评分、父候选与提案比较、种群选择消耗的任务 rollout 总额度，与评测调用次数预算分别计算。 | 必填，无默认值。 |
| Optuna Proposer                                       | `python.timeoutMs`                                | 单次 Python worker 调用的时长上限，单位毫秒。                                                             | 无单次 worker 调用的独立时长上限。                                                |
| Optuna Proposer                                       | `maxSamplingAttempts`                             | 整个搜索的采样尝试次数上限，包含不进入评测的重复参数组合；评测次数另由 `policy.config.maxTrials` 限制。   | 不额外限制采样尝试次数。                                                          |
| Reflection 文件                                       | `budget.modelCalls`                               | 单次 Reflection 的模型请求数上限；设为 0 时不启动内置生成器，正数上限需要后端支持计量。                   | 无单次 Reflection 的模型调用次数上限。                                            |
| Reflection 文件                                       | `budget.timeoutSeconds`                           | 单次 Reflection 的时长上限，单位秒。                                                                      | 无单次 Reflection 的独立时长上限。                                                |
| Target                                                | `entries[].content.maxBytes`                      | Target 条目内单个文件的内容大小上限，单位字节。                                                           | Target 不设置单文件大小上限。                                                     |
| Target                                                | `constraints.maxChangedFiles`                     | 一次候选提交最多允许修改的文件数。                                                                        | Target 不限制变更文件数。                                                         |
| Target                                                | `constraints.maxChangedBytes`                     | 一次候选提交中，变更文件的内容总大小上限，单位字节。                                                      | Target 不限制变更文件的内容总大小。                                               |
| Policy 调用步骤                                       | `steps[].with.editConstraints.maxChangedFiles`    | 契约支持时，限制这次编辑最多修改多少个文件。                                                              | 不增加这次编辑的文件数上限；Target 等已有约束仍生效。                             |
| Policy 调用步骤                                       | `steps[].with.editConstraints.maxChangedBytes`    | 契约支持时，限制这次编辑的变更文件内容总大小，单位字节。                                                  | 不增加这次编辑的字节数上限；Target 等已有约束仍生效。                             |
| Policy 调用步骤                                       | `steps[].with.editConstraints.maxChangedSubtrees` | 候选编辑最多涉及多少个 Target 条目对应的文件或目录范围。                                                  | 不限制这次编辑涉及的 Target 条目数量。                                            |

搜索行为沿用 Codex 原生配置。含专家角色的调用保留父 rollout，供完整上下文的原生委派使用；无角色调用仍使用临时线程。已确认且清理完成的起服失败可被拒绝后继续；SDK 评测失败、取消或清理不明会停止实验。
