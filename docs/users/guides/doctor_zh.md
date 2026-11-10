# 使用 doctor 诊断实验

[English](doctor.md) | 简体中文 · [入门指南](../getting-started_zh.md)

## 1. doctor 的目的是什么

`ember-rsi doctor` 用于在启动实验前，检查实验配置、输入和已支持的运行前提是否就绪。准备好 Recipe、更换组件、模型或密钥，或者将实验迁移到另一环境后，都可以先运行它。

```sh
ember-rsi doctor my-experiment/recipe.yaml
```

在源码仓库中，先执行 `pnpm build`，再使用 `pnpm ember-rsi doctor my-experiment/recipe.yaml`。需要事先设置所选组件使用的环境变量；RSI 不会自动加载 `.env` 文件。

doctor 将 Recipe 校验与组件专用探测结合起来，可以发现提示词或基线缺失、绑定不兼容、镜像尚未缓存、已能证实的磁盘空间不足，以及某一侧的模型服务拒绝其密钥等问题。提案与评测可能在不同位置运行、使用不同密钥，因此分别检查连接。

doctor 不运行优化 Policy，不让模型回答问题，不执行真实评测，也不下载缺失的数据集或镜像。结果只说明检查当时已经证实的事实，不能证明任务正确性、性能或优化收益。`run` 独立运行，不会自动调用 doctor，也不要求先生成 doctor 报告。

## 2. doctor 的机制简介

### 加载与分发

1. **加载注册。** CLI 沿用正常 Runtime 注册流程，加载内置组件、`~/.ember-rsi/plugins/<name>/index.mjs` 中的用户扩展，以及 `--plugin-dir` 指定的扩展。扩展需要导出 `register(registry)`。
2. **加载生效 Recipe。** `Recipe.load` 校验 Schema、绑定、契约兼容性、Policy 编译、预算和已声明的 Reflection 资源。探测使用合并 Policy 默认配置与 Recipe 覆盖后的配置。加载失败时输出失败诊断，不再执行组件探测。
3. **检查已声明的本地路径。** 对 Application、每个生效绑定及已配置的 Reflection 实现，检查 Schema 中用 `x-rsi-path` 标记的本地文件或目录是否存在、类型是否正确、是否可读。相对路径依据声明该配置值的文件解析。URL 形式的资源不下载。
4. **执行匹配的内置探针。** 按 `agent.pi` 这样的具体插件实现 ID 分发，而不是按公共契约分发。每个绑定单独记录结果；前提不可用时，依赖它的检查记为 `unchecked`，独立检查仍可继续。没有对应内置探针的实现会明确记录为 `unchecked`。
5. **清理并输出。** 内置探针使用隔离临时存储，传递取消信号，释放自己创建的实例、进程和容器，并删除临时文件。原有制品可作为输入读取，探测产生的捕获与写入留在临时 Runtime 内。doctor 不创建优化实验，也不向原实验存储记录真实 Measurement。

多数检查的时限是 30 秒；专用探针可以采用其他时限，例如模型列表请求为 10 秒、缓存任务元数据为 60 秒。这不是整个命令只能运行 30 秒。取消后还会等待自有资源清理。报告会对已识别的密钥及包含凭据的 URL 脱敏。

### 读取 JSON 报告

正常完成时向 stdout 输出一份 JSON 报告，包括配置或注册失败的情况：

| 字段               | 含义                                                                               |
| ------------------ | ---------------------------------------------------------------------------------- |
| `recipeId`         | 已加载的 Recipe ID；未能成功加载时为 `null`。                                      |
| `summary`          | `passed`、`failed`、`unchecked` 三类检查的数量。                                   |
| `checks`           | 每项结果的 `id`、`status`，以及可选的 `binding`、`pluginId`、`reason`、`details`。 |
| `missingResources` | 缺失输入的引用、配置字段、资源种类，以及因此未执行的依赖检查 ID。                  |

组件检查 ID 以绑定名开头：名为 `agent` 的 Pi 绑定会产生 `agent.model-config` 和 `agent.model-access`。更换绑定名后，前缀也随之变化。`recipe.validate` 是 Recipe 加载校验的结果。

| 状态        | 如何理解                                                                           |
| ----------- | ---------------------------------------------------------------------------------- |
| `passed`    | 该项检查已证实其 ID 和说明所描述的事实。                                           |
| `failed`    | 发现错误，或必须执行的探测未能完成，例如密钥被拒绝或请求超时。应先阅读原因再重试。 |
| `unchecked` | 无法建立结论，例如镜像未缓存、前提检查失败，或所选执行路径没有探针。               |

退出码 `1` 表示至少有一项失败；`0` 表示没有失败项，**其中可以包含未检查项**。中断返回 `130`；省略 Recipe 参数等命令用法错误返回 `2`。后两类情况不保证有完整 JSON 报告。即使退出码为零，也需要阅读 `unchecked` 项。

## 3. doctor 针对内置组件都检查什么

内置映射覆盖以下 17 个实现，只探测生效 Recipe 中实际存在的组件。表中各项也会接受前述注册、配置、契约和已声明路径的通用检查。下表检查 ID 省略绑定名前缀。

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

| 实现                       | 实际检查                                                                                                                                                                                 | 不能据此证明的内容                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `evaluator.agentbench`     | `configuration`、`sdk-configuration`、`services`；在支持的路径上检查缓存任务元数据、所选任务 ID、Docker CPU/内存、镜像缓存、磁盘观测与容量、只读挂载及所选 solver 的模型连接，详见下表。 | 不拉取或构建镜像、不下载任务、不运行 solver 或 verifier、不执行评测。其他执行路径及不可用缓存前提保留未检查。 |
| `evaluator.inferencebench` | `configuration`、`sdk-configuration`：校验 Application 兼容性，用占位端点装配并加载 SDK 生效配置。                                                                                       | `inference-endpoint` 保留 `unchecked`，因为端点需要 Application 在真实实验中创建；不启动或访问服务。          |
| `evaluator.operatorbench`  | `operator-task`、`sdk-configuration`：读取 `task.json`、`problem.py`、`test.py`，校验任务与用例身份，用第一个用例验证 SDK assessment 配置。                                              | 不执行算子 assessment，不证明加速器、驱动或评测依赖已经就绪。                                                 |

Agentbench 的详细运行探测接在 SDK 的本地 Docker 执行路径上。若选择远程 Docker daemon，仍会探测该 daemon；由 SDK deployment 派发到其他执行节点的路径不在这些协调节点检查的覆盖范围内。

| 检查 ID                                                        | 已建立的事实与未检查边界                                                                                                                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services`                                                     | 解析所有已声明服务的模型与地址引用，以及所选 solver/verifier 所需的凭据。这是配置校验，不是逐个服务的网络连接测试。                                                                          |
| `dataset-source` / `dataset-cache-inspection`、`task-metadata` | 检查支持的本地 Harbor 任务源或已有缓存，读取任务元数据并验证所选 ID。注册中心发现、缓存缺失、未支持的 benchmark 探针，或相对于每次评测目录的路径，可能使元数据保留未检查；不下载数据集。     |
| `docker`、`docker-capacity`                                    | 从所选 daemon 读取 `NCPU` 与 `MemTotal`，与可获得的任务 CPU、内存声明比较。任务元数据缺失时无法完成比较。                                                                                    |
| `task-image-<index>`、`task-builds`、`gateway-image-cache`     | 检查求解、验证、辅助服务及网关的镜像缓存。需要构建的内容保留未检查。缺失缓存镜像记入资源及其依赖检查，doctor 不自动拉取。                                                                    |
| `workspace-cache-mounts`                                       | 用已缓存网关镜像，通过只读挂载读取自有标记文件与可用数据集。没有受支持的本地数据集、辅助镜像缺失或无法确认镜像层已在本地时，不执行主动探测。                                                 |
| `docker-disk-space`、`docker-disk-capacity`                    | 测量 daemon 节点上已支持的文件系统，并比较已知增量需求，见下文磁盘判定。                                                                                                                     |
| `gateway-model-access`                                         | 从已缓存网关镜像容器中，仅查询选中的 solver 服务，使用 SDK 生效模型与地址、该服务的密钥及 SDK 运行时代理。前提缺失或执行路径不支持时保留未检查；没有单独查询 verifier/judge 服务的模型列表。 |

### 模型连接判定

Pi 与支持的 Agentbench 网关分别从自己的执行位置，使用自己的凭据请求 `GET <base_url>/models`。评测侧回环地址按 SDK 网关规则改用 `host.docker.internal`，其运行时代理路线与 RSI 宿主进程的路线分开处理。

只有服务返回 HTTP `200`、JSON 包含有效的 `data` 模型数组、各项 ID 均为非空字符串，并且配置的模型 ID 精确匹配其中一项时，该模型列表检查才通过。鉴权拒绝、模型缺失、无效回复、超时和网络错误分别给出说明，指向对应一侧的密钥、模型名、地址或网络。提案连接成功不能推导出评测也能连接。

Codex 的原生健康检查、服务可达性与模型可用性分别报告。当前内置接入不会把原生健康诊断成功当作 `/models` 包含配置模型的证据。

### 磁盘判定

磁盘可用量在所选 Docker daemon 节点测量，包括 Docker Desktop 虚拟机或远程 Docker 主机，不能用当前终端所在磁盘代替。[`docker system df`](https://docs.docker.com/reference/cli/docker/system/df/) 返回已用量和可回收量，不是文件系统剩余容量；[containerd 存储还可能与 DockerRootDir 分离](https://docs.docker.com/engine/storage/containerd/#disk-space-usage)。

容量核算分别处理镜像拉取、解包、SDK 派生镜像构建及声明的任务运行空间，并按目标平台对缓存镜像和层去重。已缓存镜像的汇总 `Size` 不会再次计作增量需求。缺失大小和无法定位的存储位置在 `details` 中保留未知，未知字节数使用 `null`。最大的生效 `resources.storage` 声明是已知下界，不是已强制执行的配额，也不是并发工作的峰值。

能证实空间不足，或 daemon 返回 `ENOSPC` 时记为 `failed`，保留实测可用量、已知需求和能够计算的缺口。否则，解包、构建、运行需求缺失或内容存储位置未知时，容量仍为 `unchecked`。磁盘空间观测可以通过，而容量结论仍未检查。主动辅助探针只使用缓存镜像且不访问网络；懒拉取或未识别的 snapshotter 无法确认层已在本地时，不启动辅助容器。

## 4. 自定义组件如何接入 doctor

### 通过正常注册自动参与通用检查

正常注册自定义组件，并在 Recipe 或 Policy 中选择它，就会自动参与注册、配置 Schema、绑定与契约、已声明本地路径的检查。完整插件与 Policy 示例见[编写插件](writing-plugins_zh.md)。

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

构建插件后，在扩展目录的 `index.mjs` 中注册其定义：

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

绑定名为 `custom` 时，上例产生 `custom.resource.inputFile`，提供 `assets` 时还会产生 `custom.resource.assets`。Schema 标记的相对路径按声明文件解析。未标记的字符串不会被推断为路径；URL 形式的值跳过检查，不会下载。通用路径检查不会展开 `${ENV}`，因此需要为这些检查提供具体路径。环境引用解析由组件自己的实现或探针负责，JSON Schema 的字符串校验不会代办。

### 当前边界：没有公开的自定义探针接口

具体实现 ID 没有对应内置探针时，该组件会得到 `custom.plugin: unchecked`。doctor 不调用它的 `create` 或 `execute`，因此写在 `create` 中的额外校验也不会执行。与内置组件实现同一个公共契约，不会继承该组件的探针。

当前插件定义不支持 `doctor` 或 `check` 字段，添加后会被 Registry 拒绝。没有公开的 `registerDoctor` API、doctor 专用的 CLI 探针加载选项，也没有导出 `DoctorScript` / `DoctorContext` API。runner 的内部 `scripts` 选项只是测试替换入口，不是安装后扩展机制。因此，自定义组件可以接入前述自动检查，但目前不能通过普通扩展注册追加业务探测。

### 在 RSI 源码中增加内置探针

这需要修改框架源码并重新构建 CLI：

1. 针对具体插件 ID 实现内部 [DoctorScript](../../../src/runtime/doctor/types.ts)，放入对应职责的[内置检查模块](../../../src/runtime/doctor/scripts.ts)。
2. 用 `context.check` 记录有时限的操作，用 `context.unchecked` 表达不支持或前提不可用，用 `context.missing` 记录缺失输入与依赖检查。runner 负责添加绑定名前缀、脱敏和汇总。
3. 临时写入放在 `context.directory` 或隔离 Runtime 中，传递本项检查的取消信号，在成功、失败和中断时清理资源。不执行 Agent、Policy 或真实评测，不下载或构建缺失资源。
4. 增加行为、失败及相关取消与清理测试，将探针按实现 ID 加入内置映射，再重新构建。同步更新本指南，说明真实覆盖范围和限制。

现有 [doctor 测试](../../../tests/unit/doctor.test.ts)与 [Evaluator 测试](../../../tests/unit/doctor-evaluators.test.ts)展示了结果汇总、前提处理、取消与清理方式。
