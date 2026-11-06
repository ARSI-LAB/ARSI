# 运行与检查实验

[English](running-experiments.md) | 简体中文 · [快速入门](../getting-started_zh.md)

本指南介绍如何校验、运行、检查、取消和恢复实验，以及通过 CLI 与工作台排查问题。

从应当拥有实验 `.rsi/` 目录的工作区运行命令。Recipe 资源路径按声明文件解析，默认数据存储位置则取决于进程工作目录。分别启动的 CLI 和工作台从同一工作区运行时会读取同一存储。

## CLI 命令

使用 `ember-rsi --help` 或 `<command> --help` 查看当前安装版本的语法。在源码仓库中未全局安装时，可以使用 `pnpm ember-rsi`。

| 命令                                                        | 用途                                                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ember-rsi catalog`                                         | 列出已注册插件和 Policy ID。                                                                  |
| `ember-rsi list plugins`                                    | 查看插件描述、契约、Schema 和兼容的 Policy 绑定。                                             |
| `ember-rsi list policies`                                   | 查看 Policy 描述、Schema、依赖和兼容插件。                                                    |
| `ember-rsi validate <recipe.yaml>`                          | 校验配置和组装关系，不运行实验。                                                              |
| `ember-rsi run <recipe.yaml> --id <experiment-id>`          | 启动真实实验并保存记录。                                                                      |
| `ember-rsi list`                                            | 列出已保存的实验。                                                                            |
| `ember-rsi show <experiment-id>`                            | 输出已保存的实验状态、结果和错误信息。                                                        |
| `ember-rsi cancel <experiment-id>`                          | 保存取消请求。                                                                                |
| `ember-rsi run <recipe.yaml> --id <experiment-id> --resume` | 从保存状态恢复指定实验。                                                                      |
| `ember-rsi dashboard --port 4317`                           | 在本机回环地址提供已构建的观察界面，要求已有 `.rsi/` 目录。                                   |
| `ember-rsi reflection list [experiment-id]`                 | 列出持久化版本，可按实验筛选。                                                                |
| `ember-rsi reflection show <revisionID>`                    | 检查版本内容与计划中的资源变更。                                                              |
| `ember-rsi reflection apply <revisionID>`                   | 将快照写到记录的用户资源路径；参见 [Reflection 规则](reflection_zh.md#将版本应用到后续实验)。 |

`--plugin-dir <directory>` 可以重复使用。校验、运行、恢复和观察自定义配置时应加载相同扩展。默认先加载 `~/.ember-rsi/plugins/<name>/index.mjs`，再加载显式目录。参见 [扩展注册](writing-plugins_zh.md#为-cli-注册外部扩展)。

## 校验与启动

对于教程 Recipe：

```sh
ember-rsi validate my-experiment/recipe.yaml
ember-rsi run my-experiment/recipe.yaml --id terminal-skills-01
```

`validate` 检查 Recipe、插件配置、契约兼容性、Policy 编译和已声明的 Reflection 资源，不会初始化 Bundle、加载基准镜像、启动 Python 或远端推理、检查凭据或调用模型。这些前提需要在运行前准备。`run` 会发起真实外部调用，消耗模型和计算资源。

在同一工作区的另一终端中查看进度：

```sh
ember-rsi list
ember-rsi show terminal-skills-01
```

`show` 输出已保存的实验记录，不提供实时完成百分比估算。工作台展示已记录的调用、候选关系、测量与轨迹，可用于进一步检查。耗时的评测调用可能持续运行到已配置的基准超时；模型请求和完整 Agent 调用各有独立限制。

## 读取结果与证据

分别检查三个层次：

1. **实验状态。** `succeeded`、`failed`、`cancelled` 描述记录的执行结果；Policy 完成不代表分数有所提升。
2. **测量有效性。** 核对技术状态、覆盖率、任务 ID、候选引用、指标定义和比较条件。完整成功执行下的零分，与准备失败、部分覆盖和缺失指标不同。指标选择需要可比的测量。
3. **最终输出。** 沿 Policy 结果中的引用检查内容。WikiSkill 返回 `candidateRef`、验证 `measurementRef`、`memoryRef` 和可选的 `testMeasurementRef`；Harness² 返回基线和各任务选中的 `deliveries`。复用候选前先检查文件和证据。

事实与收据位于 `.rsi/facts/`，不可变制品位于 `.rsi/artifacts/`，实验专属工作资源位于 `.rsi/experiments/<experiment-id>/`。恢复时需保留存储和原始资源文件。通过管理/查询接口或工作台检查记录，不要编辑事实来制造状态或恢复位置。

Memory 和 Reflection 的修改需要后续实际使用：保存 Memory 不会让所有插件自动读取，激活指导资源也不代表模型已使用。判断在线修改效果时，需要验证同一个未结束实验中的后续执行。按 Policy 的任务划分，测试测量用于最终报告，不作为学习证据。

## 取消与恢复

```sh
ember-rsi cancel terminal-skills-01
ember-rsi show terminal-skills-01
```

取消只是请求，不证明所有工作已经停止。活动 Runtime 会传递取消信号并清理自身资源，需要检查最终状态和清理记录。在启动 CLI 的终端按 Ctrl+C 也会发送取消信号。

恢复时沿用工作区、原始 Recipe 路径、实验 ID 和所需扩展：

```sh
ember-rsi run my-experiment/recipe.yaml --id terminal-skills-01 --resume
```

Runtime 恢复锁定的定义、预算用量、生效版本、调用收据和检查点，并拒绝不兼容修改。恢复不会重置计数或实验开始时间，已配置的墙钟预算包含中断期间。保留未完成运行使用的实现与资源；有意修改配置后，使用新的实验 ID。

成功收据和已完成步骤可以复用。已确定为失败或取消的调用，只有插件通过 `canRetry` 确认重放不会重复产生副作用时才可重试；未知或仍在运行的外部结果需要先协调。恢复不保证外部执行恰好一次。清理失败单独记录，嵌入宿主提供显式的 [清理协调](writing-plugins_zh.md#嵌入-runtime)。

Memory 更新失败时保留原 `memoryRef`（首次为 null），保存失败收据且不产生变更引用。Reflection 更新失败时保留生效指导并记录拒绝。这些学习失败本身不会取消实验；用户取消、实验总预算耗尽和关键 Runtime 持久化失败仍会停止执行。恢复到已持久化、已完成的失败 Memory 边界时，复用该结果。

## 工作台

```sh
ember-rsi dashboard --port 4317
```

从已有 `.rsi/` 的实验工作区运行，然后打开输出地址。界面展示实验、概览、候选、差异、测量、调用、Agent 轨迹、结果和图表。启动、恢复和取消实验仍通过 CLI 进行。已保存轨迹可能不完整或不可用，缺失数据不代表没有发生调用。

实验详情中的 **Reflection & Memory** 页签用于检查学习过程：

- **Reflection**：查看插件修订版本、状态、原因和内容，使用 `Changes` 或 `Full contents` 比较修改或阅读全文。
- **Memory**：查看经验更新、状态、原因和文档内容，通过 `View call` 跳转到对应调用。
- **应用 Reflection 修改**：选择版本，点击 `Preview application`，核对将新增、覆盖或删除的源文件，确认后点击 `Apply changes`。这会写入原始用户资源，后续实验可使用这些修改；适用范围和阻止条件与 CLI 相同，见[将版本应用到后续实验](reflection_zh.md#将版本应用到后续实验)。

`dashboard` 提供构建后的静态资源，源码修改后执行 `pnpm build`。开发 UI 时，`pnpm dev:web` 启动 Vite，默认将 `/api` 代理到 4317 端口，需要另行启动后端。工作台监听回环地址并检查 Host/Origin，不提供面向公网部署的用户认证。

## 排障

| 现象                                      | 检查事项                                                                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recipe 拒绝 `ref` 或 Policy 拒绝 `finish` | 使用 `application.plugin`、`policy.id`、绑定 `plugin`，以及有序且声明类型的 `steps`；参见 [配置](configuration_zh.md) 与 [Policy 语法](writing-policies_zh.md)。 |
| 未知插件、Policy 或未声明绑定             | 检查当前 catalog，在此进程加载扩展，并匹配 Policy 的 `require`。只有文件并不构成注册。                                                                           |
| 校验通过但执行失败                        | 检查 Bundle/Target、基准资源、Docker context 和容量、宿主机与容器的模型访问，或推理/Python 前提，并保留原生错误。                                                |
| 预算耗尽或请求超时                        | 区分操作、评测、模型计数，墙钟时长，单请求时长，整个 Agent 时长，以及基准时长。参见 [限制](configuration_zh.md#限制与预算)。                                     |
| Selector 拒绝比较                         | 检查完整成功覆盖、相同的指标定义和比较条件，不要重命名缺失指标以强行选择。                                                                                       |
| 工作台提示缺少 `.rsi` 或展示了其他实验    | 从原实验工作区启动，使用同一存储；只有 API-ready 提示时重新构建。                                                                                                |
| 修改配置或资源后恢复失败                  | 恢复兼容配置，或启动新实验；外部结果未知时，重复副作用前先检查收据。                                                                                             |
| Memory 失败或 Reflection 被拒绝           | 检查保存的原因和后续流程。之前的经验或指导可能仍有效；失败与正常无修改不同。                                                                                     |
