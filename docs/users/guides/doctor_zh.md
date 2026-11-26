# 使用 doctor 诊断实验

[English](doctor.md) | 简体中文 · [入门指南](../getting-started_zh.md)

## 1. 简介

`arsi doctor` 用于在启动实验前，检查实验配置、输入和已支持的运行前提是否就绪。准备 Recipe、更换组件、模型或凭据，或迁移实验环境后都可以运行。

```sh
arsi doctor my-experiment/recipe.yaml
```

- 在源码仓库中，完成 `pnpm build` 后使用 `pnpm arsi doctor my-experiment/recipe.yaml`，运行前设置所选组件需要的环境变量。
- `doctor` 将 Recipe 校验与组件专用检查结合起来，可以发现提示词或基线缺失、绑定不兼容、提案侧模型连接失败，以及 SDK 报告的评测配置、运行前提或下载路线问题。

## 2. doctor 的机制简介

### 加载与分发

正常完成时的检查流程如下：

```mermaid
flowchart TD
    A["运行 arsi doctor"] --> B["加载 Runtime 并注册内置组件和扩展"]
    B --> C{"注册成功？"}
    C -- 否 --> D["记录 runtime.registration 失败"]
    C -- 是 --> E["加载并校验 Recipe<br/>合并生效配置"]
    E --> F{"校验成功？"}
    F -- 否 --> G["记录 recipe.validate 失败"]
    F -- 是 --> H["准备隔离临时 Runtime<br/>遍历 Application、绑定和运行时演进模块"]
    H --> I["检查已声明的路径和绑定引用"]
    I --> J{"声明的路径和绑定引用均有效？"}
    J -- 是 --> K["创建绑定实例，调用其可选的 rsi/doctor"]
    K --> Q["汇总结果、未订阅或初始化失败"]
    J -- 否 --> L["报告首个失败<br/>停止该绑定的后续检查"]
    Q --> M["补充绑定信息并汇集结果"]
    L --> M
    M --> N{"还有组件？"}
    N -- 是 --> I
    N -- 否 --> O["清理已创建的资源<br/>汇总并脱敏"]
    D --> O
    G --> O
    O --> P["输出摘要或 JSON 报告<br/>有 failed：退出码 1；否则：退出码 0"]
```

1. **加载注册。** CLI 沿用正常 Runtime 注册流程，加载内置组件、`~/.arsi/plugins/<name>/index.mjs` 中的用户扩展，以及 `--plugin-dir` 指定的扩展。
2. **加载生效 Recipe。** `Recipe.load` 校验 Schema、绑定、契约兼容性、Policy 编译、预算和已启用的 Memory 和 Reflection 资源。
   - 探测使用合并 Policy 默认配置与 Recipe 覆盖后的配置。
   - 加载失败时输出失败诊断，不再执行组件探测。
3. **检查已声明的前提。** 对 Application、每个生效绑定及每个已启用的运行时演进模块，检查 Schema 中用 `x-rsi-path` 标记的本地文件或目录是否存在、类型是否正确、是否可读，并检查用 `x-rsi-binding` 标记的字段是否指向实现了指定契约的 Recipe 绑定。
4. **执行组件检查。** 若声明的路径或绑定引用检查失败，doctor 报告该失败，然后继续检查下一个绑定。上述前提通过时，doctor 会创建临时实例，等待其可选的 `rsi/doctor` 回调和 `dispose()`。初始化失败会记录该绑定的错误，其他绑定继续检查。实例未订阅时，该绑定的 `plugin` 检查记为 `unchecked`。
5. **清理并输出。** RSI 检查使用隔离临时存储，传递取消信号，释放自己创建的实例与进程，并删除临时文件。原有 artifacts 可作为输入读取，RSI 产生的捕获与写入留在临时 Runtime 内。

### 阅读摘要和 JSON 报告

每个绑定在首次失败后停止后续检查，后续项记为 `unchecked`；此前结果保留，其他绑定继续检查。数量按全部输出项统计。声明前提失败时不会创建插件实例，组件诊断记为 `unchecked`。

`doctor` 默认向 stdout 输出可读摘要，包含检查数量、失败项、未检查项和可用的修复建议。

脚本或需要完整探测证据时，可以请求 JSON 报告。

```sh
arsi doctor my-experiment/recipe.yaml --json
```

报告包含以下字段，配置加载或注册失败时也会输出。

| 字段       | 含义                                                    |
| ---------- | ------------------------------------------------------- |
| `recipeId` | 已加载的 Recipe ID。未能成功加载时为 `null`。           |
| `checks`   | 每项结果包含 `id` 和 `status`，也可附上检查范围和证据。 |

从 `checks` 筛选失败项或按状态计数。可选字段包括 `binding`、`pluginId`、`reason` 和 `details`。通过 `reason` 查看失败原因、未检查的原因和可用的修复建议。

组件检查 ID 以绑定名开头。名为 `agent` 的 Pi 绑定依次输出 `agent.model-config`、`agent.model-access`；模型配置失败时，第二项记为 `unchecked`。更换绑定名后，前缀也随之变化。

| 状态        | 如何理解                                                                           |
| ----------- | ---------------------------------------------------------------------------------- |
| `passed`    | 该项检查已证实其 ID 和说明所描述的事实。                                           |
| `failed`    | 发现错误，或必须执行的探测未能完成，例如密钥被拒绝或请求超时。应先阅读原因再重试。 |
| `unchecked` | 无法建立结论，例如原生工具不支持该项诊断，或端点只有执行时才会创建。               |

即使退出码为零，也需要阅读未检查项。两种输出格式使用相同的退出码。中断和命令用法错误时可能没有完整摘要或报告。

- `1` 表示至少有一项失败；
- `0` 表示没有失败项，**其中可以包含未检查项**。
- 中断返回 `130`。如果中断发生在 Runtime 清理期间，且清理失败，stderr 会同时显示中断原因和清理错误。
- 省略 Recipe 参数等命令用法错误返回 `2`。

## 3. doctor 针对内置组件都检查什么

以下内置实现都提供 `rsi/doctor` 处理器。doctor 检查生效 Recipe 中选中的组件。

### Application 与 Agent

| 实现                      | 实际检查                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `application.agentbundle` | 1. 检查目标定义、基线和必需文件是否可读。<br>2. 初始化应用并校验 AgentBundle 内容。<br>3. 获取临时实例，读取内容，释放实例并确认清理完成。                    |
| `application.kernel`      | 1. 检查目标定义、基线和内核源文件。<br>2. 初始化应用并校验内核源码结构。<br>3. 获取临时实例，读取源码，释放实例并确认清理完成。                               |
| `application.inference`   | 1. 检查目标定义和基线输入。<br>2. 检查本地启动命令、工作目录和资源，或远程控制脚本的解释器、脚本及参数文件。<br>3. 检查凭据所需的环境变量和启动配置是否合法。 |
| `agent.pi`                | 1. 校验模型、服务地址、密钥和 token 限制的配置。<br>2. 从 RSI 进程连接模型服务，确认模型列表包含所选模型。                                                    |
| `agent.codex`             | 1. 检查 Codex 命令是否可用、是否支持原生诊断。<br>2. 使用 `options` 中 Codex 的 `-c` / `--config` 覆盖，在隔离项目中运行原生诊断并读取结果。                                               |
| `agent.claudecode`        | 检查 CLI 参数和原生 JSON 认证状态。安装诊断仅有文本输出，标为 `unchecked`，可自行运行 `claude doctor`；不验证模型访问。                                       |
| `agent.dsh`               | 检查 CLI 参数，并展开 headless 配置以发现配置组合错误。可能刷新原生缓存；不验证动态模型路由、存储凭据或模型访问。                                             |
| `agent.opencode`          | 检查 V2 CLI 版本、必要参数，以及原生配置能否与 RSI 只读 Agent 组合。使用独立实例，可能刷新原生缓存。                                                          |

对于 `application.inference`，加载 Recipe 时会检查 `healthcheck.path` 和 `endpoint.basePath` 是否以单个 `/` 开头。远程模式要求路径省略查询字符串和片段。`doctor` 和 `run` 都在启动服务前检查这些规则。

### Proposer、Memory、Reflection 与 Selector

Doctor 检查已启用的运行时演进模块配置、显式指定的 Memory 源目录和选用的 Agent。当 `memory.agent` 或 `reflection.agent` 省略 `implementation.config.agentRef` 时，Doctor 会检查 Policy 声明的唯一 `contract.agent` 绑定。如果 Policy 没有声明或声明了多个这类绑定，Doctor 会检查该模块使用的内部绑定 `_evolutionAgent`（`agent.pi`）。禁用模块跳过资源加载。Reflection 配置中的 `proposer: '*'` 选择该绑定已配置的本地资源，包括 `prompt`、`skills` 目录和 `subagents` 的提示词文件。如果选中的目标包含内置资源，Doctor 会在 `reflection.targets` 检查项中提示如何导出。

| 实现                        | 实际检查                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proposer.agent`            | 1. 检查所选 Agent 的绑定和兼容性。<br>2. 读取提示词、Skill 和角色提示词。<br>3. 准备隔离编辑项目，确认这些输入可以正确装配。                      |
| `proposer.operator`         | 1. 检查所选 Agent 的绑定和兼容性。<br>2. 读取算子任务及用例，核对任务与用例标识。<br>3. 读取阶段提示词、外部知识、检索所需资源及可选硬件说明。          |
| `proposer.grid`             | 1. 检查参数路径、搜索轴名称和网格规模。<br>2. 读取 Application 基线中 `config.path` 指向的文件，确认内容为 JSON 对象。                                  |
| `proposer.optuna`           | 1. 校验采样器、搜索空间和约束处理配置。<br>2. 读取 Application 基线中 `config.path` 指向的文件，确认内容为 JSON 对象。<br>3. 检查 Python 依赖及其版本。 |
| `proposer.pareto-evolution` | 1. 检查提示词模块定义是否合法。<br>2. 检查各模块文件是否存在于本地基线或文件树制品中。                                                                  |
| `summarizer.operator`       | 检查 `promptFile` 是否可读且包含非空白文本。                                                                                                            |
| `memory.agent`              | 1. 检查所选 Agent 的绑定和兼容性。<br>2. 读取提示词、Skill 和角色提示词。<br>3. 在隔离项目中装配编辑环境。                                        |
| `reflection.agent`          | 1. 检查所选 Agent 的绑定和兼容性。<br>2. 读取提示词、Skill 和内置评审角色提示词。<br>3. 在隔离项目中装配编辑环境。                                |
| `selector.metric`           | 1. 校验指标选择配置。<br>2. 检查候选资格条件和约束上下界，并确认组件可以创建和释放。                                                                    |
| `selector.artifact`         | 1. 检查所选 Agent 的绑定和兼容性。<br>2. 读取选择提示词、Skill 和角色提示词。<br>3. 准备隔离的选择项目。                                          |
| `selector.inference`        | 1. 校验推理选择配置。<br>2. 检查约束上下界，并确认组件可以创建和释放。                                                                                  |

### Evaluator

三个 Evaluator 都通过各自的配置适配器调用已安装的 Evaluator SDK doctor。配置与输出路径位于隔离的临时目录。

通过 `sdk-doctor.details` 查看原生检查与网络证据。`sdk.coverage` 和 `sdk.network` 分别报告前提覆盖范围和网络就绪情况。

| 实现                       | 实际检查                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `evaluator.agentbench`     | 1. 核对 Application 兼容性，准备 AgentBundle 路径和选中的任务。<br>2. 将评测配置交给 SDK 检查。 |
| `evaluator.inferencebench` | 1. 核对 Application 兼容性，用占位推理端点准备评测配置。<br>2. 将评测配置交给 SDK 检查。        |
| `evaluator.operatorbench`  | 1. 读取算子任务，使用首个用例准备评测配置。<br>2. 将评测配置交给 SDK 检查。                     |

- SDK 根据配置检查 Docker、Python、声明的本地输入及 Ray 连接前提。**网络诊断会实际下载临时资源，Docker 路径还会测试镜像获取和 `FROM`、`RUN` 构建。** SDK 负责清理探测资源，已下载的基础镜像可能留在缓存中。
- 原生前提出现 `not-checked` 时，`sdk.coverage` 记为 `unchecked`；网络汇总为 `incomplete` 时，`sdk.network` 记为 `unchecked`。SDK 可以因覆盖不完整而返回退出码 `1`。收到有效报告后，RSI 根据检查结果决定自己的退出码。

## 4. 自定义组件如何接入 doctor

在组件的 `create(config, ctx)` 中订阅 `rsi/doctor`。参见[编写插件](writing-plugins_zh.md)。

### 编写诊断事件处理器

从 `arsi/contracts` 或 `arsi` 导入 `OperationDoctor<C>`、`DoctorContext<C>` 和 `DoctorRule`。

- 处理器由临时插件实例持有。`doctor` 命令为每个绑定传入其生效配置。
- 组件未订阅 `rsi/doctor` 时，框架仍执行通用检查，并将组件专用的 `plugin` 项标为 `unchecked`。

| 类型                 | 用途                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `OperationDoctor<C>` | 返回 `DoctorRule[]` 或 `Promise<DoctorRule[]>`。                                                                            |
| `DoctorContext<C>`   | 生效配置、隔离 Runtime、临时目录及命令取消信号。                                                                            |
| `DoctorRule`         | 包含 `id`、惰性布尔判断 `check(signal)` 和失败原因/修复提示 `reason`。不支持的诊断省略 `check`，可通过 `details` 保存证据。 |

- `C` 是组件配置类型。本例在 `schema.ts` 中导出 `type CustomConfig = { inputFile: string }`，那么 `context.binding.config.inputFile` 就会被推导为 `string`。

示例在已有 `configSchema` 中将字符串 `inputFile` 声明为必填字段，并用 `'x-rsi-path': 'file'` 标记本地文件。通用检查负责验证路径，下面的 `doctor.ts` 检查文件内容。

```ts
import { readFile } from 'node:fs/promises';
import type { DoctorContext, DoctorRule } from 'arsi/contracts';
import type { CustomConfig } from './schema.js';

export function doctor(context: DoctorContext<CustomConfig>): DoctorRule[] {
  async function isInputReady(signal: AbortSignal): Promise<boolean> {
    const text = await readFile(context.binding.config.inputFile, {
      encoding: 'utf8',
      signal,
    });
    return Boolean(text.trim());
  }

  return [
    {
      id: 'input-content',
      check: isInputReady,
      reason:
        'inputFile is empty or unreadable; restore its contents or correct inputFile.',
    },
    {
      id: 'remote-service',
      reason: 'This component does not diagnose the remote service.',
    },
  ];
}
```

I/O 应使用每项检查收到的信号，失败或取消后仍须释放资源。返回 false 时使用定义的 `reason`，异常或超时会附上诊断信息。可选 `timeoutMs` 覆盖默认单项时限，`null` 表示由原生流程管理时限。

在 `service.ts` 中导入 `doctor`，从 `arsi/contracts` 导入 `RuntimeContext` 类型，将工厂参数标注为 `ctx: RuntimeContext<CustomConfig>`，再在工厂内订阅。扩展入口照常调用 `registry.registerOperation(customDefinition)`。

```ts
ctx.event.on('rsi/doctor', doctor);
```

构建扩展后，通过 CLI 加载它的 `index.mjs`。

```sh
arsi doctor my-experiment/recipe.yaml --plugin-dir ./my-extension
```

## 5. doctor 的时间限制

doctor 按顺序检查各个绑定。命令总耗时取决于各项检查与清理。RSI 检查和 Evaluator SDK 探针各自计时。

| 操作或检查 ID                                       | 时限                                               | 计时范围                                                                             |
| --------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 框架检查执行                                        | 默认每项 60 秒                                     | 本地路径、SDK 配置准备、Application 验证与获取各自计时，同一项内的多个操作共用时限。 |
| `agent.codex` 的 `executable`、`doctor`             | 各 60 秒                                           | CLI 帮助与原生 doctor 帮助共用 `executable` 时限，原生 JSON 诊断另算一项。           |
| `agent.claudecode` / `agent.dsh` / `agent.opencode` | 每项 60 秒                                         | CLI 兼容性、Claude 认证及 DSH/OpenCode 配置。                                        |
| Pi 的 `model-access` HTTP 请求                      | 每次请求 10 秒                                     | 包含 HTTP 请求和完整响应正文读取，位于外层 60 秒检查内。                             |
| Optuna 的 `python-dependencies`                     | 外层 60 秒，同时受已配置的 `python.timeoutMs` 约束 | 更短的 worker 时限可提前结束，更长的值不能延长外层 RSI 检查。                        |
| Evaluator SDK 的连通性与下载探针                    | 按 SDK 单项计时                                    | 当前固定 SDK 给可执行程序检查与 Ray TCP/TLS 检查 5 秒，每项下载网络探针 180 秒。     |
| Evaluator SDK 的 Ray 下载诊断                       | 节点进程 3000 秒，协调端等待 3100 秒               | 节点进程的计时覆盖该节点的探测，协调端计时覆盖结果收集。                             |

嵌套时限以先到期者为准。Pi 请求自己的 10 秒包含在外层 60 秒中，不能额外相加。CLI 没有 doctor 专用的超时参数，这些时限也不取自 Recipe 的实验预算。Pi/Codex/Claude Code/DSH 的 `config.timeoutMs` 用于真实 Agent 执行，参见[配置 Recipe、Target 与组件](configuration_zh.md)。

RSI 检查超时会记为 `failed`，表示探测未完成。取消探测后，执行器最多再等待 **15 秒**使其结束。若检查超时且等待结束时探测仍未完成，同一检查项的原因会说明清理无法确认。最后清理 Runtime 和临时目录还需要额外时间。

Evaluator 取消时，RSI 请求 SDK 结束探测并清理资源。SDK 最长有 60 秒响应。超时或取消消息无法送达时，RSI 开始强制终止进程树，此时 Docker daemon 所有资源的清理状态仍为未知。当前固定 SDK 给删除探测镜像的操作 30 秒。下载的基础镜像可能留在缓存中。
