# 使用 doctor 诊断实验

[English](doctor.md) | 简体中文 · [入门指南](../getting-started_zh.md)

## 1. 简介

`ember-rsi doctor` 用于在启动实验前，检查实验配置、输入和已支持的运行前提是否就绪。

```sh
ember-rsi doctor my-experiment/recipe.yaml
```

- `doctor` 将 Recipe 校验与组件专用检查结合起来，可以发现提示词或基线缺失、绑定不兼容、提案侧模型连接失败，以及 SDK 报告的评测配置、运行前提或下载路线问题。Evaluator 诊断直接来自已安装 SDK 的 doctor，RSI 不再维护另一套评测探针。

完整 SDK doctor 会执行临时下载与 Docker 构建探针，也可能获取镜像；下载的基础镜像可以留在缓存中。它不让模型回答问题，不执行真实评测或优化 Policy，也不能证明任务正确性、性能或优化收益。`run` 独立运行，不会自动调用 doctor，也不要求先生成 doctor 报告。

## 2. doctor 的机制简介

### 加载与分发

正常完成时的检查流程如下：

```mermaid
flowchart TD
    A["运行 ember-rsi doctor"] --> B["加载 Runtime 并注册内置组件和扩展"]
    B --> C{"注册成功？"}
    C -- 否 --> D["记录 runtime.registration 失败"]
    C -- 是 --> E["加载并校验 Recipe<br/>合并生效配置"]
    E --> F{"校验成功？"}
    F -- 否 --> G["记录 recipe.validate 失败"]
    F -- 是 --> H["准备隔离临时 Runtime<br/>遍历 Application、绑定和 Reflection"]
    H --> I["检查当前组件声明的本地路径"]
    I --> J{"按插件实现 ID 匹配到<br/>内置检测脚本？"}
    J -- 是 --> K["执行检测脚本"]
    K --> Q["分别记录各项检查结果<br/>passed、failed 或 unchecked"]
    J -- 否 --> L["将该组件的 plugin 检查<br/>记为 unchecked"]
    Q --> M["汇集当前组件的结果和缺失资源"]
    L --> M
    M --> N{"还有组件？"}
    N -- 是 --> I
    N -- 否 --> O["清理已创建的资源<br/>汇总并脱敏"]
    D --> O
    G --> O
    O --> P["输出 JSON 报告<br/>有 failed：退出码 1；否则：退出码 0"]
```

1. **加载注册。** CLI 沿用正常 Runtime 注册流程，加载内置组件、`~/.ember-rsi/plugins/<name>/index.mjs` 中的用户扩展，以及 `--plugin-dir` 指定的扩展。
2. **加载生效 Recipe。** `Recipe.load` 校验 Schema、绑定、契约兼容性、Policy 编译、预算和已声明的 Reflection 资源。探测使用合并 Policy 默认配置与 Recipe 覆盖后的配置。加载失败时输出失败诊断，不再执行组件探测。
3. **检查已声明的本地路径。** 对 Application、每个生效绑定及已配置的 Reflection 实现，检查 Schema 中用 `x-rsi-path` 标记的本地文件或目录是否存在、类型是否正确、是否可读。
4. **执行组件的 doctor 能力。** runner 调用已注册组件定义上的可选 `doctor` 函数。它随组件一起导出、打包和注册，不需要单独维护全局检查映射。每个绑定的各项检查分别记录为 `passed`、`failed` 或 `unchecked`。Evaluator 定义通过正常 RSI 配置 adapter 委托已安装 SDK 的公开 `doctor` CLI；RSI 只映射返回的诊断，不再自行探测 Docker、磁盘或评测模型服务。前提不可用时，依赖它的检查记为 `unchecked`，独立检查仍可继续。定义未声明 `doctor` 时，该绑定的 `plugin` 检查记为 `unchecked`。
5. **清理并输出。** RSI 检查使用隔离临时存储，传递取消信号，释放自己创建的实例与进程，并删除临时文件。原有制品可作为输入读取，RSI 产生的捕获与写入留在临时 Runtime 内。下载与构建探针及其清理由 SDK 负责，镜像缓存可能改变。doctor 不创建优化实验，也不向原实验存储记录真实 Measurement。

### 时间限制、超时与取消

doctor 按顺序检查绑定，**没有整个命令的统一总时限**。RSI 通用检查与委托执行的 SDK doctor 分别管理时限：

| 操作或检查 ID                           | 时限                                               | 计时范围                                                                                                        |
| --------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 通用 `context.check` 检查               | 默认每项 60 秒                                     | 本地路径、配置、Application 验证与获取各自计时，同一项内的多个操作共用时限。                                    |
| `agent.codex` 的 `executable`、`doctor` | 各 60 秒                                           | CLI 帮助与原生 doctor 帮助共用 `executable` 时限，原生 JSON 诊断另算一项。                                      |
| Pi 的 `model-access` HTTP 请求          | 每次请求 10 秒                                     | 包含 HTTP 请求和完整响应正文读取，位于外层 60 秒检查内。                                                        |
| Optuna 的 `python-dependencies`         | 外层 60 秒，同时受已配置的 `python.timeoutMs` 约束 | 更短的 worker 时限可提前结束，更长的值不能延长外层 RSI 检查。                                                   |
| Evaluator SDK doctor                    | 由 SDK 管理，不套用单个 RSI 60 秒总计时器          | 当前固定 SDK 的 CLI 可执行程序与 Ray TCP/TLS 检查为 5 秒，下载或网络探针每项最多 180 秒，多个探针可以顺序执行。 |

嵌套时限以先到期者为准。Pi 请求自己的 10 秒包含在外层 60 秒中，不能额外相加。CLI 没有 doctor 专用的超时参数，这些时限也不取自 Recipe 的实验预算。Pi/Codex 的 `config.timeoutMs` 用于真实 Agent 执行，参见[配置 Recipe、Target 与组件](configuration_zh.md)。

RSI 检查超时会记为 `failed`，说明探测未完成，不能据此认定插件不可用。通用检查取消后，runner 最多再等待 **15 秒**使其结束；否则额外记录 `<绑定名>.<检查 ID>.cleanup: failed`。最终 Runtime 与临时目录清理不受该等待统一覆盖，因此命令不保证在 60 秒或 75 秒内返回。

Evaluator 的取消信号转交给 SDK 调用，最多等待 60 秒让原生取消与清理完成，之后 RSI 才强制终止无响应的进程树。强制终止无法确认 Docker daemon 所拥有资源的清理情况。探针时限与临时资源清理由 SDK 管理；当前固定 SDK 的网络 doctor 给生成镜像的删除操作 30 秒。SDK 的超时和未支持位置根据其报告映射。完整 SDK doctor 可以运行超过 60 秒，已下载的镜像也可能保留在缓存中。

### 运行结果

正常完成时向 stdout 输出一份 JSON 报告，包括配置或注册失败的情况：

| 字段               | 含义                                                                               |
| ------------------ | ---------------------------------------------------------------------------------- |
| `recipeId`         | 已加载的 Recipe ID；未能成功加载时为 `null`。                                      |
| `summary`          | `passed`、`failed`、`unchecked` 三类检查的数量。                                   |
| `checks`           | 每项结果的 `id`、`status`，以及可选的 `binding`、`pluginId`、`reason`、`details`。 |
| `missingResources` | 缺失输入的引用、配置字段、资源种类，以及因此未执行的依赖检查 ID。                  |

组件检查 ID 以绑定名开头，例如，名为 `agent` 的 Pi 绑定会产生 `agent.model-config` 和 `agent.model-access`；更换绑定名后，前缀也随之变化。

| 状态        | 如何理解                                                                           |
| ----------- | ---------------------------------------------------------------------------------- |
| `passed`    | 该项检查已证实其 ID 和说明所描述的事实。                                           |
| `failed`    | 发现错误，或必须执行的探测未能完成，例如密钥被拒绝或请求超时。应先阅读原因再重试。 |
| `unchecked` | 无法建立结论，例如前提检查失败，或所选执行路径没有相应诊断。                       |

退出码如下，注意后两类情况不保证有完整 JSON 报告。即使退出码为零，也需要阅读 `unchecked` 项：

- `1` 表示至少有一项失败；
- `0` 表示没有失败项，**其中可以包含未检查项**。
- 中断返回 `130`；
- 省略 Recipe 参数等命令用法错误返回 `2`。

## 3. doctor 针对内置组件都检查什么

以下 17 个内置实现都在自己的定义上声明 `doctor` 能力，只探测生效 Recipe 中实际存在的组件。表中各项也会接受前述注册、配置、契约和已声明路径的通用检查。下表检查 ID 省略绑定名前缀。

### Application 与 Agent

| 实现                      | 实际检查                                                                                                                                                                        | 不能据此证明的内容                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `application.agentbundle` | `baseline`、`verify-bundle`、`acquire-instance`、`cleanup`：读取 Target 和基线目录或制品，通过真实初始化验证必要文件及 bundle 内容，获取临时实例、读取 bundle、释放并确认释放。 | 不执行 harness Agent，也不评测 bundle。                                                                       |
| `application.kernel`      | `baseline`、`verify-source`、`acquire-instance`、`cleanup`：读取 Target 与基线，验证内核源码结构，获取、读取并释放临时源码实例。                                                | 不执行 Python，不编译内核，不验证正确性或速度。                                                               |
| `application.inference`   | `baseline`、`launch-prerequisites`：检查本地启动命令、工作目录和资源路径；或检查远程控制器所用解释器、脚本与参数 JSON；检查已配置的凭据环境引用及插件构造。                     | 不启动或获取推理服务，不验证远程机器状态。                                                                    |
| `agent.pi`                | `model-config`：解析自己的模型、地址和密钥引用，校验 URL 与 token 限制；`model-access`：从 Pi 实际所在的 RSI 进程查询模型列表。                                                 | 不请求推理；发现模型不能证明生成权限或模型行为正常。                                                          |
| `agent.codex`             | `executable`：定位配置的 CLI 并检查命令支持；`doctor`：在隔离的受管项目中，使用自己的认证、配置的模型与思考等级，执行原生 JSON 诊断，支持时采用 `--network-only`。              | `model-access` 保留 `unchecked`：原生健康诊断不能证明模型在列表中。不支持原生 doctor 的版本会明确标为未检查。 |

### Proposer、Memory、Reflection、Selector 与 Search

| 实现                      | 实际检查                                                                                                                                                                      | 不能据此证明的内容                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `proposer.agent`          | `agent-binding`、`editing-inputs`、`prepare-project`：校验 Agent 引用及契约，读取提示词、指导、Skill 和配置的角色提示词，并装配隔离编辑项目。                                 | 不生成或提交提案。                                       |
| `proposer.operator`       | `agent-binding`、`operator-task`、`operator-resources`，以及可选的 `hardware-context`：加载任务文件、校验任务与用例身份，读取阶段提示词、显式知识、检索资源及可选硬件上下文。 | 不执行检索、不调用模型、不运行内核、不探测加速器硬件。   |
| `proposer.grid`           | `configuration`：构造并释放插件，校验参数路径、搜索轴名称和网格规模。                                                                                                         | 不枚举提案或提交候选。                                   |
| `proposer.optuna`         | `python-dependencies`：用配置的 sampler、搜索空间和约束处理方式运行 Python worker 的依赖检查动作，校验依赖和版本响应。                                                        | 不运行优化，也不请求参数建议。                           |
| `memory.agent`            | `agent-binding`、`editing-inputs`、`prepare-project`：检查 Agent，并在隔离项目中准备配置的提示词、指导、Skill 与角色。                                                        | 不整理经验，不证明 Memory 有收益。                       |
| `reflection.agent`        | `agent-binding`、`editing-inputs`、`prepare-project`：检查 Agent、配置的编辑输入及内置 reviewer，并准备隔离项目。                                                             | 不提出、接受或激活 Reflection 修订。                     |
| `selector.metric`         | `configuration`：构造并释放插件，包括资格过滤与约束的上下界校验。                                                                                                             | 不比较真实 Measurement，不证明运行时一定产生配置的指标。 |
| `selector.artifact`       | `agent-binding`、`editing-inputs`、`prepare-project`：检查 Agent，并准备选择提示词、指导、Skill 与角色。                                                                      | 不让 Agent 选择制品。                                    |
| `search.prompt-evolution` | `modules`、`baseline-modules`：校验模块定义，并确认声明的模块文件存在于本地基线或文件树制品中。                                                                               | 不运行 GEPA 搜索，不编辑模块，不评测得分。               |

### Evaluator

三个 Evaluator 统一复用已安装 SDK 的完整 doctor CLI。RSI 使用正常评测路径的 adapter 准备 SDK 配置，将配置和输出路径放在隔离探测目录内，再映射 SDK 报告，不再保留另一套 Docker、磁盘、缓存或评测模型探针。

| 实现                       | RSI 配置准备                                                                                    | SDK 诊断及边界                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `evaluator.agentbench`     | 校验 Application 与 AgentBundle 的组合，绑定 bundle 目录、Policy 选中的任务 ID 和自有输出位置。 | 将生效的服务、benchmark、环境和调度配置交给 SDK doctor，不执行 solver/verifier 任务。 |
| `evaluator.inferencebench` | 校验推理 Application 组合，用尚未启动的占位端点准备 SDK 配置。                                  | 委托 SDK 检查运行前提和下载网络，不创建或验证真实推理端点。                           |
| `evaluator.operatorbench`  | 加载算子任务，用选中的用例及自有 manifest、输出路径准备 SDK assessment 配置。                   | 委托 SDK 检查运行前提和下载网络，不执行内核 assessment 或加速器计算。                 |

绑定名为 `evaluator` 时，结果 ID 包括：

| 检查 ID                                                    | 含义                                                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `evaluator.configuration`                                  | RSI adapter 配置准备，包括 Application/RSI 所拥有字段的约束。                                                    |
| `evaluator.sdk-doctor`                                     | SDK 调用及报告校验；调用成功不表示 SDK 的每项诊断都通过。                                                        |
| `evaluator.sdk.check-<index>`                              | SDK 的一项运行前提诊断，保留其名称和说明。SDK 的 `passed`、`failed` 直接映射，`not-checked` 映射为 `unchecked`。 |
| `evaluator.sdk.network`                                    | SDK 下载网络汇总，`incomplete` 映射为 `unchecked`；各探针的原始结果、证据、路线与处理建议保留在 `details` 中。   |
| `evaluator.model-access`、`evaluator.docker-disk-capacity` | Agentbench 明确记为 `unchecked`，因为当前固定 SDK 不确认评测模型列表访问与磁盘容量。                             |
| `evaluator.inference-endpoint`                             | Inferencebench 记为 `unchecked`，因为真实端点需要 Application 在实验中创建。                                     |

SDK 按所选配置检查：配置与凭据变量、Docker/Python 是否可用、声明的本地数据集或 bundle 路径、Ray 连接前提及执行节点覆盖范围。完整网络诊断会真实下载临时资源，Docker 路径还会测试镜像获取及 `FROM`/`RUN` 构建。这些是 SDK 自身的探针，不是 RSI 预热或任务执行。即使生成的探测资源已清理，下载的基础镜像也可能继续留在缓存中。

当前固定的 SDK doctor **不查询评测模型列表、不测量 daemon 剩余磁盘、不比较增量存储需求、不枚举缓存任务元数据，也不逐一验证任务镜像缓存**。RSI 不会从 SDK 报告成功推导出这些结论。SDK 明确将模型/任务执行及未支持的执行节点就绪情况保留未检查。输入或凭据配置缺失可能使 SDK 无法生成报告，此时记为 SDK 调用失败。

SDK CLI 的退出码 `1` 既可能表示诊断失败，也可能只是网络覆盖不完整。RSI 根据返回状态映射，不会将这类退出码全部视为失败；只有未检查项而没有失败项的报告，仍可使 RSI 返回 `0`。

### 提案侧模型连接

Pi 从实际所在的 RSI 进程，使用自己的生效模型、地址和凭据请求 `GET <base_url>/models`。只有 HTTP `200`、JSON 包含有效的 `data` 模型数组、各项 ID 为非空字符串且精确匹配配置模型 ID 时才通过。鉴权拒绝、模型缺失、无效回复、超时和网络错误分别给出说明，不让模型回答问题。

Codex 的原生健康、服务可达性与模型可用性分别报告。原生健康诊断通过不能证明模型列表中包含配置模型。Pi 或 Codex 提案侧健康也不能证明评测模型可访问；后者不在当前 SDK doctor 的覆盖范围内。

## 4. 自定义组件如何接入 doctor

### 声明可选的 doctor 能力

在导出 `contract`、`configSchema`、`create` 的同一个组件定义上增加可选的 `doctor` 函数，仍然调用普通的 `registry.registerOperation(definition)`。检查函数随组件一起导出、打包和注册，不需要修改 RSI 源码、增加注册调用或维护全局映射。完整插件与 Policy 示例见[编写插件](writing-plugins_zh.md)。

在组件的 `configSchema` 中声明本地输入：

```ts
export const configSchema = {
  type: 'object',
  properties: {
    inputFile: { type: 'string', 'x-rsi-path': 'file' },
    assets: { type: 'string', 'x-rsi-path': 'directory' },
  },
  required: ['inputFile'],
  additionalProperties: false,
};
```

在 `doctor.ts` 中实现组件的额外检查，再编译为 `doctor.js`。回调接收生效绑定配置和隔离的诊断上下文：

```ts
import { readFile } from 'node:fs/promises';
import type { OperationDoctor } from 'ember-rsi/contracts';

type CustomConfig = { inputFile: string; assets?: string };

export const checkCustom: OperationDoctor<CustomConfig> = async (context) => {
  await context.check('input-content', async (signal) => {
    const text = await readFile(context.binding.config.inputFile, {
      encoding: 'utf8',
      signal,
    });
    if (!text.trim()) throw new Error('inputFile must contain text.');
  });
};
```

将它放到组件定义上：

```js
import { proposerContract } from 'ember-rsi/contracts';
import { configSchema } from './schema.js';
import { createCustom } from './service.js';
import { checkCustom } from './doctor.js';

export const customDefinition = {
  id: 'proposer.custom',
  contract: proposerContract,
  configSchema,
  create: createCustom,
  doctor: checkCustom,
};
```

随组件一起构建、部署这些文件，再在扩展目录的 `index.mjs` 中注册定义：

```js
import { customDefinition } from './dist/index.js';

export function register(registry) {
  registry.registerOperation(customDefinition);
}
```

让 doctor 加载与 `run` 相同的扩展：

```sh
ember-rsi doctor my-experiment/recipe.yaml --plugin-dir ./my-extension
```

绑定名为 `custom` 时，上例先产生自动的 `custom.resource.inputFile` 和可选的 `custom.resource.assets` 检查，再由组件的 doctor 产生 `custom.input-content`。Schema 标记的相对路径按声明文件解析。未标记的字符串不会被推断为路径；URL 形式的值跳过检查，不会下载。通用路径检查不会展开 `${ENV}`，因此需要为这些检查提供具体路径。环境引用解析由组件负责，JSON Schema 的字符串校验不会代办。

### 回调约定与生命周期

TypeScript 作者可以从 `ember-rsi/contracts` 或根入口 `ember-rsi` 导入 `OperationDoctor<C>`、`DoctorContext<C>`。`C` 是组件配置类型，对应 `context.binding.config`。回调签名为 `async function checkCustom(context): Promise<void>`，通过提供的上下文记录结果，不自行返回整份报告。JavaScript 作者使用同样的函数，省略类型标注即可。

| 上下文成员                        | 用途                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `binding.config`                  | 读取已通过 Schema 校验的生效配置，包含默认值、覆盖值和已解析的声明路径。     |
| `check(id, action, options?)`     | 执行有时限的操作并记录成功或失败，向 action 提供取消信号，返回该项是否通过。 |
| `unchecked(id, reason, details?)` | 记录不支持的工作，或因前提不可用而未执行的依赖检查。                         |
| `missing(resource)`               | 记录缺失输入及因此保留未检查的依赖检查 ID。                                  |
| `runtime`、`directory`、`signal`  | 使用隔离诊断服务与存储，并传递取消信号。                                     |

注册和 `Recipe.load` 会保留该能力，但不执行它。CLI 只在 `doctor` 期间调用该函数，正常 `create`、`execute` 和实验运行不会自动调用它。doctor 不会为了发现额外检查而实例化未覆盖的自定义组件。定义省略 `doctor` 时，自动结构与路径检查仍会运行，`custom.plugin` 记为 `unchecked`。实现同一个公共契约不会继承另一实现的 doctor 函数。

runner 负责添加绑定名前缀、对已知凭据脱敏、汇总结果和清理临时 Runtime。检查 ID 保持为绑定内的局部名称，使用回调提供的上下文，不导入 Runtime 内部实现。

临时写入放在 `context.directory` 或隔离 Runtime 中，将每项检查的信号传给外部请求或进程，在成功、失败和中断时通过 `finally` 清理自有资源。不执行 Agent、Policy 或真实评测；说明下载或构建副作用，SDK-backed Evaluator 的诊断继续委托 SDK。测试可用输入、具体的前提故障及相关取消与清理行为，再通过安装后的 CLI 加载打包扩展验证。

现有 [doctor 测试](../../../tests/unit/doctor.test.ts)与 [Evaluator 测试](../../../tests/unit/doctor-evaluators.test.ts)展示了结果汇总、前提处理、取消与清理方式。
