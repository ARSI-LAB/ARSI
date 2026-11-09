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

优化流程中的 Agent 负责生成提案、评审交付内容、整理经验等模型任务，内置后端为 Pi 和 Codex。Evaluator 的配置与优化 Agent 分开：AgentBench 配置被测 Agent（Solver）的模型服务，InferenceBench 配置推理服务基准，OperatorBench 配置算子评测环境。

两个后端都在为 Agent 调用准备好的 workspace 中运行。`contract.agent` 接收 `cwd`、`goal` 和 `outputSchema`，Pi 通过 Runtime 委派时还会传入 `role`。Codex 使用原生工具委派。后端从 `AGENTS.md` 读取指令，并从工作目录读取任务材料。

| 配置对象               | 用途                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| Evaluator              | 配置所选基准的模型服务、任务或评测环境。                         |
| Pi（`agent.pi`）       | 通过 Pi 调用指定的模型服务，执行优化流程中的 Agent 任务。        |
| Codex（`agent.codex`） | 通过本机 Codex 执行优化流程中的 Agent 任务，沿用本地登录和配置。 |

### 环境变量

RSI 不会自动加载 `.env` 文件，需要在启动 CLI 的进程中导出变量。

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

InferenceBench 在本地执行 AgentX。省略 `services` 时，候选实例绑定到默认服务。如果通过 `benchmark.solver.service` 指定了其他服务名，Recipe 需要声明对应的服务条目。该条目可以配置 `retry`、`contextWindow` 等 SDK 选项。显式填写 `model`、`base_url` 或 `api_key` 都会报错。凭据引用在 Application 的 `credentials.apiKeyEnv` 中配置。其余服务条目按 SDK 要求填写。

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

### Codex 后端

`agent.codex` 通过本机已安装的 Codex CLI 执行优化任务，沿用本地登录和配置。将 Agent 绑定切换到该后端：

```yaml
bindings:
  agent:
    plugin: agent.codex
    config: {}
```

这个后端的准备和调用分工如下：

- **开发者负责准备环境**：安装或更新 Codex CLI，并在 Recipe 中选择 `agent.codex`。使用启动 RSI 的同一系统用户运行 `codex login` 完成登录，再用 `codex login status` 检查；模型服务和原生工具权限也在该用户的 Codex 配置中设置。
- **RSI 自动完成调用**：RSI 框架会启动 `codex app-server`，为本次任务创建临时工作目录和会话，提供提示词与文件读取工具，校验返回结果，并在结束时清理进程和临时目录。

Codex 用户配置默认位于 `~/.codex/config.toml`，见 [OpenAI Docs 配置说明](https://learn.chatgpt.com/docs/config-file/config-basic)。RSI 默认在系统临时目录运行 Codex；实验专用指令应通过相应插件的 `prompt`、`guidance` 等资源传入。

- 仓库里的 `AGENTS.md` 和 `.codex/config.toml` 不会自动成为本次调用的项目配置

[Codex Schema](../../../src/plugins/agent-codex/schema.ts) 接受 `executable`（默认 `codex`）、可选的 `model`、`thinkingLevel` 和 `timeoutMs`。省略 `model`、`thinkingLevel` 时沿用本地默认值，显式填写则只覆盖本次调用的模型和推理强度，不改写本地配置。

- `timeoutMs` 限制完整调用，接受 1 到 2,147,483,647 的整数毫秒，实验取消和已配置的墙钟预算也会传递给进程。

- 目前该后端无法执行实验的 `modelCalls` 预算。

## Proposer 文件编辑

`proposer.agent` 使用一套 Agent 输出 Schema。`edits` 中的每一项都有路径和 `op`。`replace` 和 `create` 提供完整的 `content`，`patch` 在 `changes` 中提供精确的 `oldText` 和 `newText`，`delete` 只需提供路径。同一个提案可以对不同路径使用不同操作。Proposer 和 Application 会执行编辑约束和 Target 权限检查。

如果路径使用了 `patch`，该路径只能有一条操作。同一路径上的多条整文件编辑仍按现有规则合并和处理冲突。

迁移自定义 Proposer prompt 时，从绑定配置删除 `editProtocol`，并为每条 edit 添加 `op`。整文件编辑中，已有文件用 `replace`，新文件用 `create`，删除用 `delete`。已有的带 `op` 的 patch 操作保留原有字段。

## 限制与预算

Recipe 中省略的绑定配置会先继承 Policy 默认值。下表的“缺省时”指对应配置最终仍未设置该项的情况；其他层的限制仍可能生效。

| 位置                                                  | 配置项                                            | 含义                                                                                                      | 缺省时                                                                            |
| ----------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Recipe                                                | `budget.operations`                               | Runtime 操作调用总数上限，包含嵌套调用。                                                                  | 无实验级次数上限。                                                                |
| Recipe                                                | `budget.evaluationRuns`                           | 评测调用总数上限；一次调用可包含多个任务，OperatorBench 的评测和性能分析调用均计入。                      | 无实验级评测次数上限。                                                            |
| Recipe                                                | `budget.modelCalls`                               | 支持计量的后端实际模型请求总数上限，包含重试、输出纠正和子 Agent；不限制基准 Solver 或原生 Codex 请求。   | 无实验级模型调用次数上限。                                                        |
| Recipe                                                | `budget.elapsedWallMs`                            | 整个实验的经过时间上限，单位毫秒；恢复时包含中断期间，不会重新计时。                                      | 无实验级运行时长上限。                                                            |
| Recipe                                                | `budget.cleanupReserveMs`                         | 释放实例、关闭插件等清理工作的时长上限，单位毫秒，单独计时。                                              | 无 Runtime 清理期限。                                                             |
| Pi                                                    | `maxTokens`                                       | 单次模型请求的最大输出 Token 数。                                                                         | 不发送输出 Token 上限，由模型服务决定。                                           |
| Pi                                                    | `contextWindow`                                   | Pi 用于上下文管理的窗口大小，单位 Token，应与模型能力匹配。                                               | 262144 Token。                                                                    |
| Pi                                                    | `timeoutMs`                                       | 单次模型请求的时长上限，单位毫秒。                                                                        | 底层 HTTP 客户端使用 600000 毫秒（10 分钟）。                                     |
| Pi                                                    | `executionTimeoutMs`                              | 完整 Agent 调用的时长上限，单位毫秒，包含请求、工具、压缩、重试等待和子 Agent。                           | 无整次调用的独立时长上限。                                                        |
| Codex                                                 | `timeoutMs`                                       | 完整 Agent 调用的时长上限，单位毫秒。                                                                     | RSI 不为该调用设置独立超时。                                                      |
| Operator Proposer                                     | `modelRequestTimeoutMs`                           | 一个完整模型阶段的共享时长上限，单位毫秒，包含工具续调与子 Agent。                                        | 120000 毫秒（2 分钟）。                                                           |
| AgentBench Evaluator                                  | `services.<service>.maxTokens`                    | 被测 Agent 所用模型服务的每轮输出 Token 上限。                                                            | 由 Solver 或模型服务的默认设置决定。                                              |
| AgentBench / InferenceBench Evaluator                 | `run.timeoutSeconds`                              | 单个基准任务一次执行的时长上限，单位秒。                                                                  | 使用 SDK 基准 profile 的值；profile 未指定时为 7200 秒（2 小时）。                |
| OperatorBench Evaluator                               | `benchmark.config.timeoutSeconds`                 | 单次算子评测或性能分析的时长上限，单位秒。                                                                | 默认 300 秒。启用性能分析时为 `maxAttempts × attemptTimeoutSeconds + 300` 秒。    |
| OperatorBench Evaluator                               | `benchmark.config.profiling.attemptTimeoutSeconds` | 一次性能分析尝试的时长上限，单位秒。                                                                      | SDK 默认 300 秒（5 分钟）。                                                       |
| Inference Application                                 | `remote.timeoutMs`                                | 一次远端脚本调用的时长上限，单位毫秒。                                                                    | 无远端调用的独立时长上限。                                                        |
| Inference Application                                 | `healthcheck.timeoutMs`                           | 等待推理服务就绪的时长上限，单位毫秒。                                                                    | 远端模式继承 `remote.timeoutMs`；该值也未设置或使用本地模式时，不设就绪等待上限。 |
| 提示词演化搜索 | `maxRounds` | 逻辑尝试轮数上限，包含无修改和被拒绝的尝试。 | 必填，无默认值。 |
| 提示词演化搜索 | `maxRollouts` | 初始评分、父候选与提案比较、种群选择消耗的任务 rollout 总额度，与评测调用次数预算分别计算。 | 必填，无默认值。 |
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
