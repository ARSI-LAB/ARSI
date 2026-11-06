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

| 配置对象               | 用途                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| Evaluator              | 配置所选基准的模型服务、任务或评测环境。                         |
| Pi（`agent.pi`）       | 通过 Pi 调用指定的模型服务，执行优化流程中的 Agent 任务。        |
| Codex（`agent.codex`） | 通过本机 Codex 执行优化流程中的 Agent 任务，沿用本地登录和配置。 |

### 环境变量

RSI 不会自动加载 `.env` 文件，需要在启动 CLI 的进程中导出变量。

- **模型环境变量由具体组件及其配置决定，框架没有一组统一必填的模型环境变量。**

### Evaluator

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

使用 `evaluator.inferencebench` 评测推理服务时，待测服务地址和模型名称由 `application.inference` 提供，具体配置见[推理服务示例](../../../examples/artifacts/inference/parameter-grid/README.md#configuration)。

使用 `evaluator.operatorbench` 评测算子时，`task.directory` 指定任务目录，`protocol` 设置预热次数、重复次数和正确性误差范围，`sdk` 指定 Python、NPU 设备、超时和性能分析选项。该插件需要可用的 Triton-Ascend / NPU 环境；优化 Agent 仍通过 `agent` 绑定单独配置。准备步骤和完整配置见[算子优化示例](../../../examples/artifacts/kernel/transpose-copy/README.zh-CN.md)。

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

- 目前该后端无法执行 `maxModelCalls` 或实验 `modelCalls` 预算。

## 指标选择

`selector.metric` 按指定指标比较当前最优候选与新候选。若 Policy 使用名为 `selector` 的绑定，可在 Recipe 中这样配置：

```yaml
bindings:
  selector:
    plugin: selector.metric
    config:
      metric: latencyMeanMs
      direction: minimize
      eligibility:
        - metric: candidateValid
          min: 1
      minRelativeImprovement: 0.02
```

这个例子先检查新候选是否正确，再比较延迟；只有延迟降低**超过 2%** 才替换当前最优候选。正确性不达标时直接拒绝，无需该候选提供延迟值，选择结果中的 `candidateValue` 为 `null`。

| 配置项                   | 填写方式与作用                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `metric`、`direction`    | 指定比较指标和方向：`maximize` 越大越好，`minimize` 越小越好；默认比较 `successRate`，方向为 `maximize`。                                    |
| `eligibility`            | 比较目标指标前先检查的条件列表，如正确性。每项填 `metric`，并至少填写 `min` 或 `max`；边界值包含在允许范围内。当前最优候选必须满足这些条件。 |
| `constraints`            | 候选还必须满足的额外指标限制，填写方式与 `eligibility` 相同。                                                                                |
| `minRelativeImprovement` | 改进比例下限，取值大于等于 0、小于 1，默认 0。设为正数时，当前最优候选的目标指标值必须大于 0；新候选的改进比例须严格超过此值。               |
| `itemId`、`statistic`    | 按需选择任务项及分布指标的统计量；分布指标必须指定 `mean`、`p50`、`p95` 或 `p99`。                                                           |
| `tieBreak`               | 当前仅支持 `retain-incumbent`，即相同数值保留当前最优候选。                                                                                  |

完整配置见 [Selector Schema](../../../src/plugins/selector-metrics/schema.ts)，算子示例中的搭配见[示例 Recipe](../../../examples/artifacts/kernel/transpose-copy/recipe.search.yaml)。

## 限制与预算

省略的 Runtime 预算维度没有 Runtime 上限，插件、模型服务、基准和显式继承的 Policy 限制仍可能生效。

| 位置                                                  | 配置项                                                                                     | 范围                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Recipe                                                | `budget.operations`、`budget.evaluationRuns`                                               | Runtime 调用（包含嵌套调用）；每次 Evaluator 调用可包含多个任务。                                  |
| Recipe                                                | `budget.modelCalls`                                                                        | 支持计量的后端记账的请求，包括 Pi 输出纠正和子 Agent；不限制基准 Solver 或原生 Codex 请求。        |
| Recipe                                                | `budget.elapsedWallMs`、`budget.cleanupReserveMs`                                          | 实验执行时长和独立的清理期限，单位毫秒；恢复沿用从最初开始计算的经过时间。                         |
| Pi                                                    | `maxTokens`、`contextWindow`                                                               | 每次请求的模型输出和上下文大小。                                                                   |
| Pi                                                    | `timeoutMs`、`executionTimeoutMs`                                                          | 单次请求与完整调用时长，单位毫秒。                                                                 |
| Codex                                                 | `timeoutMs`                                                                                | 完整调用时长，单位毫秒。                                                                           |
| Operator Proposer                                     | `modelRequestTimeoutMs`                                                                    | 一整个生成、诊断或总结阶段的共享时长上限，单位毫秒，包含工具续调与子 Agent。                       |
| `proposer.agent`、`memory.agent`、`selector.artifact` | `maxModelCalls`                                                                            | 后端支持时，限制每次 Agent 调用的请求数；直接调用 Agent 时设置 `steps[].with.maxModelCalls`。      |
| AgentBench Evaluator                                  | `services.<service>.maxTokens`                                                             | 该评测模型服务每轮输出上限；注意不要同时重复设置 Solver 输出上限。                                 |
| AgentBench / InferenceBench Evaluator                 | `run.timeoutSeconds`                                                                       | 基准任务超时；省略时仍应用 SDK profile 或回退值。                                                  |
| OperatorBench Evaluator                               | `sdk.timeoutSeconds`、`sdk.profiling.attemptTimeoutSeconds`                                | SDK 调用与单次性能分析尝试的时长上限，单位秒；评测与性能分析调用均计入 `budget.evaluationRuns`。   |
| Inference Application                                 | `remote.timeoutMs`、`healthcheck.timeoutMs`                                                | 远端命令和就绪等待；未覆盖时，远端就绪等待继承显式远端超时。                                       |
| Optuna Proposer                                       | `python.timeoutMs`、`maxSamplingAttempts`                                                  | 每次 worker 时长和包含重复值的总采样次数；`policy.config.maxTrials` 另行限制评测次数。             |
| Reflection 文件                                       | `budget.modelCalls`、`budget.timeoutSeconds`                                               | 每次 Reflection 调用的局部限制；`modelCalls: 0` 阻止内置模型生成器启动，正数调用上限需要后端计量。 |
| Target                                                | `entries[].content.maxBytes`、`constraints.maxChangedFiles`、`constraints.maxChangedBytes` | 文件大小及整次提交大小；这些限制需要显式配置。                                                     |
| Policy                                                | `steps[].with.editConstraints`                                                             | 契约支持时，限制单次编辑的文件数、字节数和子树数。                                                 |
