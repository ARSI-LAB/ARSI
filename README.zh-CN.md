<h1 align="center">
  <img src="docs/users/assets/ember-rsi-logo.png" alt="ember-rsi" width="520">
</h1>

<h3 align="center">多种自演进策略，一个框架统一承载 · Make Everything RSI-able.</h3>

<p align="center">
  从 Agent Harness 到 AI 基础设施，用同一套框架生成候选方案、评测效果并持续迭代。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-24.x-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24.x">
  <img src="https://img.shields.io/badge/pnpm-11.22.0-F69220?logo=pnpm&amp;logoColor=white" alt="pnpm 11.22.0">
  <img src="https://img.shields.io/badge/License-Apache--2.0-blue" alt="License: Apache-2.0">
</p>

<p align="center">
  <a href="./README.md">English</a> | 中文
</p>

<p align="center">
  <a href="#overview">简介</a> ·
  <a href="#architecture">工作原理</a> ·
  <a href="#installation">安装与部署</a> ·
  <a href="#usage">使用 ember-rsi</a> ·
  <a href="#web-workspace">查看实验进度</a> ·
  <a href="#experiment-results">实验效果</a> ·
  <a href="#user-guide">使用指南</a>
</p>

<a id="overview"></a>

## ℹ️ 简介

`ember-rsi`（Recursive Self-Improvement）是面向 Agent 与 AI 基础设施的插件化自演进实验框架，致力于 **Make Everything RSI-able**（让一切可自演进）。

- **配置文件驱动自演进**。通过一份声明式实验配方（`recipe.yaml`）绑定优化目标（`Application`）、演化策略（`Policy`）与评测器（`Evaluator`），`ember-rsi` 即可驱动目标对象在受控修改边界与固定预算下持续迭代演进。
- **内置"开箱即用"的策略并提供扩展能力**。当前已经内置用于优化 Agent Harness 和 搜索推理服务参数的策略。我们致力于"让一切可自演进"，让更多能够定义修改边界、生成候选版本并度量效果的对象接入同一套实验框架。
- **人类与 AI 都能发起实验**。开发者可通过 CLI 配置和运行实验，并在可视化观察台查看结果。AI 编程助手可借助仓库提供的 RSI Skill 操作同一套工具。我们希望 AI 能在开发者授权的目标、修改范围和预算内，自主编写配方、校验并运行实验，跟踪进度、诊断失败，并根据评测结果决定下一轮怎么做。

<a id="architecture"></a>

## 🔄 工作原理

<p align="center">
  <a href="docs/users/assets/rsi-architecture-handdrawn.svg">
    <img src="docs/users/assets/rsi-architecture-handdrawn.png" alt="ember-rsi 架构：Recipe 与 Policy 配置、RSI Core、围绕 Application 的插件循环，以及 Memory 与 Reflection 自进化" width="1200">
  </a>
</p>

1. **配置实验**。在 Recipe(实验配置) 中选定优化目标和 Policy，配置数据集、插件和预算。Policy(优化策略) 定义每轮执行哪些步骤，以及何时停止。
2. **运行 RSI 实验**。Runtime 按 Policy 执行迭代。典型流程是从基线出发，提出并校验修改、评测候选版本，再根据结果选择下一轮的起点。
3. **让组件自进化**。Policy 可调用 Memory 沉淀实验经验，供组件在后续迭代中使用，也可调用 Reflection 根据实验反馈提出对组件提示词、资源或配置的改进。

<a id="installation"></a>

## 📦 安装与部署

### Agent Instruction

将下面这段指令复制给你的编程 Agent：

```text
请从 https://github.com/evolving-foundry/ember-rsi 安装 ember-rsi CLI 和配套 skill。
按照 README 中的 CLI 手动安装说明，检查前置依赖、克隆仓库、安装依赖、构建并安装 CLI。
将完整的 skills/ember-rsi 目录（包括引用资料和模板）复制到当前 Agent 支持的 skill 目录，替换同名 skill 前先询问。
运行 ember-rsi --help，并确认当前 Agent 能发现和读取该 skill。本次只完成安装，不启动实验或调用模型。
```

### Manual Installation

#### 1. 安装 CLI

需要 **Node.js >=24.19.0 且 <25**、**pnpm 11.22.0**、Git，以及相关 GitHub 仓库的读取权限。AgentBundle 和 Evaluator SDK 通过固定的 Git 依赖安装，并在安装过程中构建，无需准备同级源码目录。

```sh
# 克隆并构建 ember-rsi。
git clone git@github.com:evolving-foundry/ember-rsi.git
cd ember-rsi
pnpm install --frozen-lockfile
pnpm build
pnpm add -g .

# 检查安装后的 CLI 是否可用。
ember-rsi --help
```

#### 2. 安装 skill

在目标项目目录执行以下命令，并选择要安装到的编程 Agent：

```sh
npx skills add evolving-foundry/ember-rsi --skill ember-rsi
```

如需用户级安装，添加 `-g`。按 Agent 的要求重新加载或重启，然后确认能发现和读取 `ember-rsi` skill。

后续命令均在 `ember-rsi` 仓库根目录执行，使用已安装的 `ember-rsi` CLI。

<a id="usage"></a>

## 🛠️ 使用 ember-rsi

<a id="quickstart"></a>

### 快速开始

#### 1. 配置模型与评测环境

下面以 [Harness² 示例](examples/harness/dsh-harness2/README.md)（WorkBuddy Office 场景）为例。请先按 Evaluator 的 [WorkBuddy 配置说明](https://github.com/evolving-foundry/ember-evaluator/blob/master/docs/users/benchmarks/workbuddy.md) 准备 **Docker**、题库与容器镜像，并确保宿主机与评测容器均可访问模型服务地址。

展开对应的系统选项，将示例值替换成实际配置。

<details>

<summary>Linux / macOS / WSL（Bash）</summary>

```bash
# 在运行 ember-rsi 的同一个终端中显式设置变量，ember-rsi 不会自动读取 .env 文件。

# 优化器模型，用于生成候选修改。
export MODEL_NAME="your-optimizer-model"

# 示例中被测 Agent 使用的评测模型，无固定默认值，必须显式设置。
# 请填写模型服务实际支持的模型名称
export EVALUATOR_MODEL_NAME="your-evaluation-model"

# 优化器和评测模型默认共用的服务地址与 API 密钥。
export MODEL_ENDPOINT="https://your-model-service.example/v1"
export MODEL_API_KEY="your-api-key"
```

</details>

<details>

<summary>Windows（PowerShell）</summary>

```powershell
# 在运行 ember-rsi 的同一个终端中显式设置变量，ember-rsi 不会自动读取 .env 文件。

# 优化器模型，用于生成候选修改。
$env:MODEL_NAME = 'your-optimizer-model'

# 示例中被测 Agent 使用的评测模型，无固定默认值，必须显式设置。
# 请填写模型服务实际支持的模型名称
$env:EVALUATOR_MODEL_NAME = 'your-evaluation-model'

# 优化器和评测模型默认共用的服务地址与 API 密钥。
$env:MODEL_ENDPOINT = 'https://your-model-service.example/v1'
$env:MODEL_API_KEY = 'your-api-key'
```

</details>

#### 2. 校验、运行与续跑实验

Harness² 默认在 10 个任务上优化 AgentBundle 基线（最多 40 次评测、72 小时实验总时限）。首次试跑可先在 [`recipe.yaml`](examples/harness/dsh-harness2/recipe.yaml) 的 `policy.config.dataset.taskIds` 中只保留第一道题：

```sh
# 校验实验配方，不启动实验。
ember-rsi validate examples/harness/dsh-harness2/recipe.yaml

# 以 my-harness2-task 为实验 ID 启动实验，会发起真实模型调用。
ember-rsi run examples/harness/dsh-harness2/recipe.yaml --id my-harness2-task

# 按实验 ID 查看已记录的运行状态和结果。
ember-rsi show my-harness2-task
```

- 候选版本、评测指标、调用收据与证据默认保存在当前目录的 `.rsi/` 下，请结合评测状态、得分和交付物判断实验结果。
- 详细用法见 `docs/users` 下的 [用户指南](docs/users/zh-CN/guide.md)、[Reflection 指南](docs/users/zh-CN/reflection.md) 和 [运行时事件说明](docs/users/zh-CN/runtime-events.md)。

若实验中断，可在同一工作目录下使用相同实验 ID 断点续跑：

```sh
# 在原工作目录使用同一配方和实验 ID，从已有断点续跑。
ember-rsi run examples/harness/dsh-harness2/recipe.yaml --id my-harness2-task --resume
```

##### 当前内置的 RSI 策略

开发者可以根据优化目标，从下表选择一项内置策略并打开对应示例，按示例说明准备环境和配方，再校验和运行实验。

| 内置策略 ID               | 演化机制概述                                                                                   | 示例入口                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `policy.harness2`         | 分别提出并评测通用改进（INV）、领域改进（DOM）与合成（Compose），匿名比较交付产物              | [`examples/harness/dsh-harness2`](examples/harness/dsh-harness2/README.md)                             |
| `policy.wikiskill`        | 在训练集上执行并沉淀 Wiki 经验记忆，生成技能修改提案，经验证集严格改善门控后进入独立测试集评测 | [`examples/harness/dsh-wikiskill`](examples/harness/dsh-wikiskill/README.md)                           |
| `policy.parameter-grid`   | 按声明顺序惰性枚举 JSON 参数空间，在延迟等 SLO 约束下搜索最优吞吐配置                          | [`examples/artifacts/inference/parameter-grid`](examples/artifacts/inference/parameter-grid/README.md) |
| `policy.parameter-optuna` | 基于 Optuna TPE 或随机采样自适应探索推理引擎参数空间，支持约束感知采样与历史重放恢复           | [`examples/artifacts/inference/parameter-tpe`](examples/artifacts/inference/parameter-tpe/README.md)   |

<a id="extensions"></a>

### 拓展开发

#### 面向人类开发者

`ember-rsi` 支持从零代码调参到自定义契约插件的渐进式扩展，完整开发示例见 [用户指南：编写 Policy 与自定义插件](docs/users/zh-CN/guide.md#3-定制绑定与插件)：

| 定制需求                                        | 扩展方式                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| 更换数据集、模型、预算上限或参与循环的具体插件  | 直接修改或覆盖 `recipe.yaml` 配置与 `bindings`                                        |
| 编排新的搜索闭环、分支并发或停止条件            | 编写 `rsi.policy/v1`的 YAML 策略并注册                                                |
| 接入新的优化目标、提案算法、评测器或 Agent 后端 | 实现 `ember-rsi/contracts` 公共契约，通过 `--plugin-dir <dir>` 挂载或直接改写源码注册 |
| 在自有平台或服务中托管实验生命周期              | 通过 Node.js API 调用 `createRuntime` 与 `validateRecipe` 嵌入运行                    |

#### 面向 AI 编程助手

将 RSI Skill 加载到支持 Skill 的编程助手后，可以直接交代优化目标、允许修改的范围和预算，让助手选择或编写 Recipe、校验配置，并在授权后运行实验、检查结果和诊断失败。

- **RSI Skill** 的入口是 [`skills/ember-rsi/SKILL.md`](skills/ember-rsi/SKILL.md)。加载时请保留整个 `skills/ember-rsi/` 目录，以便助手访问参考文档和模板。可先用[最小示例](skills/ember-rsi/references/quickstart.md)验证配方和插件能否正常协作。

<a id="web-workspace"></a>

## 🖥️ 查看实验进度

下面两个命令都要在执行 `ember-rsi run` 的同一个目录下运行。它们从该目录下的 `.rsi/` 读取实验数据。

在终端查看实验状态时，把实验 ID 传给 `show`。

```sh
ember-rsi show my-harness2-task
```

也可以启动本地只读 Dashboard，然后在浏览器打开终端显示的地址，查看实验进度。

```sh
ember-rsi dashboard
```

<a id="experiment-results"></a>

## 📊 实验效果

<table>
  <thead>
    <tr>
      <th>基准</th>
      <th>Target Agent</th>
      <th>方法</th>
      <th>基准分数</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th rowspan="3"><a href="https://github.com/Tencent/workbuddy-bench#overview">WorkBuddy Bench</a><br>Code Subset</th>
      <td rowspan="3" align="center"><a href="https://github.com/deepseek-ai/deepseek-harness">DSH</a></td>
      <td><a href="https://arxiv.org/abs/2608.27454">WikiSkill</a><br><sub>训练 10 个任务 / 验证 5 个任务</sub></td>
      <td align="center">92.9% → 96.0% <img src="docs/users/assets/score-delta-plus-3-1.svg" alt="+3.1 pp" width="62" height="20"></td>
    </tr>
    <tr>
      <td><a href="https://github.com/google-research/harness2">Harness²</a><br><sub>验证 10 个任务</sub></td>
      <td align="center">78.5% → 71.8% <img src="docs/users/assets/score-delta-minus-6-7.svg" alt="−6.7 pp" width="62" height="20"></td>
    </tr>
    <tr>
      <td><a href="https://arxiv.org/abs/2507.19457">GEPA</a></td>
      <td align="center">-</td>
    </tr>
    <tr>
      <th rowspan="3"><a href="https://github.com/Tencent/workbuddy-bench#overview">WorkBuddy Bench</a><br>Office Subset</th>
      <td rowspan="3" align="center"><a href="https://github.com/deepseek-ai/deepseek-harness">DSH</a></td>
      <td><a href="https://arxiv.org/abs/2608.27454">WikiSkill</a><br><sub>训练 10 个任务 / 验证 5 个任务</sub></td>
      <td align="center">72.3% → 91.4% <img src="docs/users/assets/score-delta-plus-19-1.svg" alt="+19.1 pp" width="62" height="20"></td>
    </tr>
    <tr>
      <td><a href="https://github.com/google-research/harness2">Harness²</a><br><sub>验证 10 个任务</sub></td>
      <td align="center">76.1% → 79.8% <img src="docs/users/assets/score-delta-plus-3-7.svg" alt="+3.7 pp" width="62" height="20"></td>
    </tr>
    <tr>
      <td><a href="https://arxiv.org/abs/2507.19457">GEPA</a></td>
      <td align="center">-</td>
    </tr>
    <tr>
      <th rowspan="3"><a href="https://www.tbench.ai/news/terminal-bench-4-0">Terminal-Bench 4.0</a></th>
      <td rowspan="3" align="center"><a href="https://github.com/deepseek-ai/deepseek-harness">DSH</a></td>
      <td><a href="https://arxiv.org/abs/2608.27454">WikiSkill</a></td>
      <td align="center">-</td>
    </tr>
    <tr>
      <td><a href="https://github.com/google-research/harness2">Harness²</a></td>
      <td align="center">-</td>
    </tr>
    <tr>
      <td><a href="https://arxiv.org/abs/2507.19457">GEPA</a></td>
      <td align="center">-</td>
    </tr>
    <tr>
      <th rowspan="2"><a href="https://github.com/SWE-bench/SWE-bench">SWE-bench Verified</a></th>
      <td rowspan="2" align="center"><a href="https://github.com/deepseek-ai/deepseek-harness">DSH</a></td>
      <td><a href="https://github.com/google-research/harness2">Harness²</a><br><sub>训练 20 个任务</sub></td>
      <td align="center">-</td>
    </tr>
    <tr>
      <td><a href="https://arxiv.org/abs/2608.27454">WikiSkill</a><br><sub>训练 20 个任务 / 验证 10 个任务</sub></td>
      <td align="center">-</td>
    </tr>
  </tbody>
</table>

- 分数按「基线 → 演化后」展示，变化量以百分点（pp）计。

<a id="user-guide"></a>

## 📖 使用指南

- **概念与全流程配置**：[用户指南](docs/users/zh-CN/guide.md)
- **组件级自演进指导**：[Reflection 使用指南](docs/users/zh-CN/reflection.md)
- **推理服务参数调优**：[推理参数搜索指南](docs/users/zh-CN/parameter-search.md)
- **事件订阅与二次开发**：[事件系统开发指南](docs/users/zh-CN/runtime-events.md)
- **完整实验配方示例**：[DSH Harness²](examples/harness/dsh-harness2/README.md) · [DSH WikiSkill (Terminal-Bench 4.0)](examples/harness/dsh-wikiskill/README.md) · [vLLM 参数网格搜索](examples/artifacts/inference/parameter-grid/README.md) · [vLLM 参数 TPE 搜索](examples/artifacts/inference/parameter-tpe/README.md)

## 🙏 致谢

感谢 [Cordis 项目](https://github.com/cordiverse/cordis) 的维护者和贡献者，ember-rsi 使用 Cordis 注册插件、隔离实验上下文和分发运行时事件。
