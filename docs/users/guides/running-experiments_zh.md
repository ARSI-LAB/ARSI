# 运行与检查实验

[English](running-experiments.md) | 简体中文 · [快速入门](../getting-started_zh.md)

本指南介绍如何校验、运行、检查、取消及重试实验，以及通过 CLI 与工作台排查问题。

从应当拥有实验 `.rsi/` 目录的工作区运行命令。Recipe 资源路径按声明文件解析，默认数据存储位置则取决于进程工作目录。分别启动的 CLI 和工作台从同一工作区运行时会读取同一存储。

## CLI 命令

使用 `arsi --help` 查看命令列表，使用 `arsi <command> --help` 查看某个命令的语法。在源码仓库中未全局安装时，可以使用 `pnpm arsi`。

| 命令                                   | 用途                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `arsi catalog`                         | 列出已注册插件和 Policy ID。                                                                  |
| `arsi list plugins`                    | 查看插件描述、契约、Schema 和兼容的 Policy 绑定。                                             |
| `arsi list policies`                   | 查看 Policy 描述、Schema、依赖和兼容插件。                                                    |
| `arsi doctor <recipe.yaml>`            | 检查生效配置、本地资源和运行前提，不运行实验。                                                |
| `arsi run <recipe.yaml>`               | 启动或续跑实验并保存记录。                                                                    |
| `arsi list`                            | 列出已保存的实验。                                                                            |
| `arsi show <experiment-id>`            | 输出已保存的实验状态、结果和错误信息。                                                        |
| `arsi cancel <experiment-id>`          | 向指定实验发送取消请求。                                                                      |
| `arsi cleanup [experiment-id]`         | [预览或清理实验资源](#清理实验资源)。                                                         |
| `arsi dashboard`                       | 在本机提供网页版的实验观察界面。                                                              |
| `arsi reflection list [experiment-id]` | 列出持久化版本，可按实验筛选。                                                                |
| `arsi reflection show <revisionID>`    | 检查版本内容与计划中的资源变更。                                                              |
| `arsi reflection apply <revisionID>`   | 将快照写到记录的用户资源路径；参见 [Reflection 规则](reflection_zh.md#将版本应用到后续实验)。 |
| `arsi help [command]`                  | 显示命令列表或指定命令的帮助。                                                                |

### 交互式 CLI

在交互终端运行 `arsi` 或 `arsi shell` 打开命令菜单。选择命令后输入参数，也可以选择 **Run custom CLI command** 输入完整命令。用单引号或双引号包住含空格的参数。自定义命令输入框也支持 `help`、`log-level`、`clear` 和 `exit`。

CI 或重定向输入输出时使用标准 CLI 输出。JSON 结果写到 stdout，日志写到 stderr。

## CLI 参数

基本语法如下，命令所需的位置参数见上表：

```text
arsi [通用选项] <命令> [位置参数] [命令选项]
```

### 通用选项

以下选项适用于各个命令：

| 选项                       | 说明                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-h, --help`               | 显示帮助并退出。`arsi --help` 显示命令列表，`arsi <command> --help` 显示该命令的参数。                                                                                                    |
| `--plugin-dir <directory>` | 从指定目录加载自定义插件和 Policy，可重复指定以加载多个扩展目录；详见[插件注册](writing-plugins_zh.md#第二步注册插件)和 [Policy 注册与 Recipe 配置](writing-policies_zh.md#注册-policy)。 |

交互式命令用一行动态显示当前调用，例如评测任务计数、Agent 的轮次和工具、推理服务就绪状态，或 Gym 评测排队状态。Evaluator 的单题结果会输出为 `Progress` 日志行。实时更新只在动态状态行上显示。工作台以及 `debug`、`trace` 级别会显示详细日志和错误堆栈。可重复指定 `--log-level`，用 `cli.runtime=trace` 这样的点分隔类别覆盖模块级别。`ARSI_LOG_LEVEL` 设置全局级别，`ARSI_LOG_LEVELS` 设置以逗号分隔的类别覆盖。相同设置以 CLI 参数为准。

实验日志默认写入 `.rsi/logs/<experiment-id>.log`。其他命令在已有 `.rsi/` 的工作区内追加写入 `.rsi/logs/cli.log`。文件默认记录阶段切换和其他调试信息，并对错误堆栈中的密钥脱敏。用 `--log-file <path>` 指定日志文件，或用 `--no-log-file` 关闭文件日志。用 `-q` 或 `--quiet` 时，终端会显示错误，并在失败时提示已保存的日志路径。

### 命令专属选项

| 命令        | 选项                   | 说明                                                |
| ----------- | ---------------------- | --------------------------------------------------- |
| `run`       | `--id <experiment-id>` | 指定实验 ID；新实验省略时自动生成，续跑时必须提供。 |
| `run`       | `--resume`             | 用传入的 Recipe 继续已有实验，必须同时提供 `--id`。 |
| `dashboard` | `--port <port>`        | 指定监听端口，默认 `4317`，取值范围为 `1`–`65535`。 |
| `dashboard` | `--public-read-only` | 以公开只读模式监听全部 IPv4 接口。 |

## 校验与启动

例如，可以通过下面的命令来校验 + 启动：

```sh
arsi doctor my-experiment/recipe.yaml
arsi run my-experiment/recipe.yaml --id terminal-skills-01
```

- `doctor` 检查 Recipe、插件配置、契约兼容性、Policy 编译和已声明的 Reflection 资源，再为本地路径检查通过的绑定创建临时实例并调用其可选的 `rsi/doctor`。默认输出可读摘要，加 `--json` 可获取包含 `recipeId` 和 `checks` 的报告。
  - 状态为 `passed`（通过）、`failed`（失败）或 `unchecked`（未检查）。
  - 检查流程、报告解读、内置检查和自定义组件接入方式，参见 [doctor 指南](doctor_zh.md)。

在同一工作区的另一终端中查看进度：

```sh
arsi list
arsi show terminal-skills-01
```

## 读取结果与证据

事实与痕迹位于 `.rsi/facts/`，不可变制品位于 `.rsi/artifacts/`，实验专属工作资源位于 `.rsi/experiments/<experiment-id>/`。

- 重试时需保留存储，并提供有效的 Recipe 及其引用的资源。

## 取消与恢复

```sh
arsi cancel terminal-skills-01
arsi show terminal-skills-01
```

取消只是请求，并不可以让所有工作立即停止。当发送请求时，Runtime 会传递取消信号并清理自身资源，需要检查最终状态和清理记录。

- 在运行 CLI 的终端按一次 Ctrl+C 会请求取消，并让 CLI 继续清理。如果 CLI 仍在运行，再按一次 Ctrl+C 可强制退出。

继续失败、取消或中断的实验时，沿用工作区、实验 ID 和所需扩展，并提供当前的 Recipe。

```sh
arsi run my-experiment/recipe.yaml --id terminal-skills-01 --resume
```

Runtime 恢复预算用量、兼容的生效版本、调用收据和检查点，校验传入的 Policy 形状后执行未完成的步骤。

旧版 Runtime 未保存控制流决策的实验需要用新实验 ID 重新启动。

- 续跑已成功的实验会返回已保存的结果和原有用量。
- Policy 步骤的顺序、ID、类型、嵌套结构和所需的插件 contract ID 需要一致。新的调用按当前注册的输入和输出 schema 校验。
- Runtime 复用已完成的 Policy 步骤和已提交的结果，用传入的绑定、配置和代码执行未完成的步骤。对于已进入的条件分支、循环迭代和 foreach，会沿用之前选中的分支、迭代或条目。重试的插件调用使用新的尝试目录，并重新获取实例。
- 重试保留已记录的用量和原始开始时间。如果实验耗尽预算，可以修改 Recipe 中的预算。
- 上次执行释放实验锁，或进程崩溃后锁过期，即可重试未完成的调用，包括标记为 `unknown` 或停留在 `running` 的调用。Runtime 归档上次的调用收据和未确认的清理记录。外部操作的结果未知时，重试可能再次执行该操作。

## 清理实验资源

每次运行结束后，RSI 都会保留可复用的资源。手动请求清理时，RSI 从当前和已归档的 Recipe 收集绑定，按 `(bindingId, pluginId)` 去重，用该组合最近保存的配置创建临时实例并调用其清理回调。配置过但从未启动的绑定也会参与。AgentBench 和 OperatorBench 可以释放 SDK 确认可回收的资源。

- `arsi cleanup` 或 `arsi cleanup --dry-run` 预览当前 `.rsi` 工作区可释放的资源。
- `arsi cleanup terminal-skills-01 --dry-run` 预览单个实验，执行 `arsi cleanup terminal-skills-01` 即可清理。
- `arsi cleanup --all` 批量清理当前工作区，跳过正在运行或恢复的实验。

自定义插件请传入运行实验时使用的 `--plugin-dir`。插件缺失或初始化失败时，该绑定会标为 `pending`，其他绑定仍会继续处理。Evaluator 清理使用 `EVALUATOR_NETWORK_CONFIG` 指定的文件，默认路径为 `~/.arsi-evaluator/network.yaml`。文件缺失时，该条记录保持 `pending`，恢复配置后可重试。

清理会保留检查点、结果、日志，以及其他实验仍在使用的资源。之后用 `--resume` 续跑或启动同类实验时，如果需要重新拉取或构建镜像，启动时间可能会变长。

## 工作台

```sh
arsi dashboard --port <端口号>
```

运行 `arsi dashboard --public-read-only --port 4317` 可公开展示一个工作区。能访问此端口的人无需登录即可读取实验记录、产物、提示词和 Agent 轨迹，请选用内容可公开的工作区。服务端仅接受 GET 和 HEAD 请求，并停用本地文件变更预览。

从已有 `.rsi/` 的实验工作区运行。工作台以web的形式展示实验、概览、候选、差异、测量、调用、Agent 轨迹、结果和图表，具体如下所示。

运行 `arsi dashboard --tracer` 可在本机端口 `8787` 启动或复用 Evaluator Tracer。在工作台侧栏点击 **Open Tracer**，再用 Tracer 的 **Open Directory** 导入包含已保存轨迹的 Evaluator 评测目录。Collector 在后台运行，导入数据保存在 `.rsi/tracer/` 下。

测量详情展示每个已记录条目的完整标识、对象类型、状态、覆盖范围和指标。失败、取消或状态未知的条目显示没有有效成绩，不展示数值结果；缺失条目证据会明确提示，成功评估的零分仍保留为零。
多个指标使用相同展示名称时，会补充原始指标名，便于区分各自的数值。

- 当前界面只读，启动、重试和取消通过 CLI 进行。
- Harness 结果增加 Delivered 列，链接到保存的选择结果所返回的测量，并显示对应阶段、状态与覆盖范围。交付均分仅使用已记录交付的可用分数，不以未选中的更高分替代；缺少选择记录时显示“Not recorded”。
- 默认将 `/api` 代理到 4317 端口。
- 没有专用报告的 Policy 在 Results 中也会展示最终输出产生前的已记录评估，并在完成后保留评估历史；最终候选仍只由保存的输出引用确定。评估列表同时显示状态与覆盖情况，失败或中断的测量不会提供最终分数。
- Results 同时展示实验记录中的执行错误。实验已经结束且没有最终输出时，页面明确显示未记录最终结果，并继续保留已有评估。

![rsi-studio-wikiskill-compact](../assets/rsi-studio-wikiskill-compact.gif)

## 排障

| 现象                                   | 检查事项                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 未知插件、Policy 或未声明绑定          | 检查当前 catalog，在此进程加载扩展，并匹配 Policy 的 `require`。注意只有文件时并不构成注册。                                 |
| 预算耗尽或请求超时                     | 区分操作、评测、模型计数，墙钟时长，单请求时长，整个 Agent 时长，以及基准时长。参见 [限制](configuration_zh.md#限制与预算)。 |
| 工作台提示缺少 `.rsi` 或展示了其他实验 | 从原实验工作区启动，使用同一存储；                                                                                           |
| Memory 失败或 Reflection 被拒绝        | 检查保存的原因和后续流程。之前的经验或指导可能仍有效；失败与正常都不会影响整体实验流程。                                     |
