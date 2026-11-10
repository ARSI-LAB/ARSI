# 快速入门

[English](getting-started.md) | 简体中文

开始前，建议先阅读[架构与核心概念](concepts/architecture_zh.md)，了解框架中的主要概念及其关系。

本例通过一个改进终端任务 Skill 的实验，演示如何配置 Application、选择内置 Policy，并编写和运行 Recipe。

- Application 定义并管理要优化的对象
- Policy 编排提案、评测和选择等改进流程
- Recipe 将两者与所需插件、参数和预算组合成一份实验配置。

## 0. 安装并准备环境

使用 Node.js 24（至少 24.19.0）、pnpm 11.22.0、Git，并确保可以访问锁定的 Git 依赖。**在源码仓库中执行**：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm add -g .

pnpm ember-rsi --help
```

AgentBundle 和 Evaluator SDK 会在安装时构建，无需相邻的源码检出目录。克隆及各平台的设置见 [仓库安装说明](../../README.zh-CN.md)。

- 真实运行前，需要准备 Docker、TerminalBench 4.0 任务和镜像，以及宿主机和评测容器都能访问的模型端点。[WikiSkill 示例](../../examples/harness/dsh-wikiskill/README.md)说明了基准环境要求。

## 1. 定义 Application

> 以下示例使用内置 Application `application.agentbundle`。如果使用其他 Application，请先查阅对应实现的配置说明和配置 Schema，再确定 Recipe 中 `application.plugin` 和 `application.config` 的填写内容。

本例用它优化 Agent Harness，需要配置以下两项：

- **Baseline** 提供实验开始时的 Agent Bundle。
- **Target** 规定 Application 可以接受哪些文件修改。

### Baseline

Baseline 就是你已经能运行、想拿来改进的那一版 Agent。

- 实验启动时，`application.agentbundle` 对 Baseline 目录生成快照，校验 Bundle 和 Skill，然后把快照登记为第一个候选。

本例直接复制仓库里的 WikiSkill Bundle。在仓库根目录执行以下命令。

```sh
mkdir -p my-experiment
cp -R examples/harness/dsh-wikiskill/baseline my-experiment/
```

复制后，`my-experiment/baseline/` 包含这些文件。

```text
baseline/
├── bundle.yaml
├── agent.yaml
├── dependencies.lock
└── plugins/terminal-base/
    ├── package.json
    ├── index.js
    ├── cordis.patch.yml
    └── prompts/baseline.md
```

该基线的提示词为空，尚无 Skill。优化流程可以在 `plugins/terminal-base/` 下创建 `skills/<name>/SKILL.md`，基线加载器会将这些 Skill 加入被评测 Agent 的系统提示词。

其中 [`bundle.yaml`](../../examples/harness/dsh-wikiskill/baseline/bundle.yaml) 声明使用哪个 Harness、从哪个配置启动 Agent，以及要加载哪些本地插件。

```yaml
schemaVersion: 1
name: dsh-wikiskill-baseline
kind: dsh-agent-bundle
harness:
  name: dsh
  version: '>=0.1.6-alpha.1 <0.2'
plugins:
  - path: plugins/terminal-base
entry: agent.yaml
lockfile: dependencies.lock
```

写自己的 Baseline 时，把原始 Agent Bundle 的清单、入口配置、依赖锁和插件文件一起放进目录。

### Target

Target 用来划定本次优化的修改范围：哪些文件或目录可以改、允许新建/修改/删除哪些文件，以及文件大小和总改动量的限制。下面以创建 `my-experiment/target.yaml`为例：

- Application 会在提交候选时校验，拒绝不符合规则的修改。

```yaml
schemaVersion: rsi.target/v1
id: target.my-terminal-skills
entries:
  # 本例只允许在 Baseline 的 `plugins/terminal-base/skills/` 下新建、修改或删除各 Skill 的 `SKILL.md`。
  - path: plugins/terminal-base/skills
    kind: directory
    description: Reusable skills loaded by the evaluated terminal Agent.
    include: ['*/SKILL.md']
    changes: [create, modify, delete]
    content: { encoding: utf-8, minBytes: 1, maxBytes: 65536 }
constraints:
  maxChangedFiles: 4
  maxChangedBytes: 131072
```

## 2. 编写 Recipe 并选择内置 Policy

> 更详细的 Recipe 编写指南可以查看 [配置指南](guides/configuration_zh.md)。

该部分用于定义实验配置，需要将下面内容保存为 `my-experiment/recipe.yaml`，与 `target.yaml` 和 `baseline/` 放在同一目录。

- 本示例使用 `policy.wikiskill`，从训练任务集学习，用验证任务集评测基线及发生修改的候选，并在搜索结束后评测测试任务集。

- 如果内置 Policy 无法满足你的流程需求，可以按[编写 Policy](guides/writing-policies_zh.md)定义并注册自定义 Policy，再在 Recipe 的 `policy.id` 中引用它。

```yaml
schemaVersion: rsi.recipe/v1
id: my-terminal-skills
application:
  plugin: application.agentbundle
  config:
    target: { schema: ./target.yaml }
    baseline: { directory: ./baseline }
policy:
  id: policy.wikiskill
  input:
    candidateRef: ${{ application.initialCandidate }}
  config:
    maxRounds: 1
    dataset:
      trainTaskIds: [terminal-bench/html-js-filter]
      validationTaskIds: [terminal-bench/formal-crypto]
      testTaskIds: [terminal-bench/bun-sourcemap-leak]
bindings:
  agent:
    plugin: agent.pi
    config:
      timeoutMs: 1800000
      executionTimeoutMs: 3600000
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
      environment:
        platform: linux/amd64
      scheduler:
        name: local
        concurrency: 1
      run:
        timeoutSeconds: 3600
budget:
  operations: 100
  evaluationRuns: 4
  modelCalls: 100
  elapsedWallMs: 21600000
  cleanupReserveMs: 60000
```

| 上面所出现字段        | 用法解释                                                                                                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`、`id` | 使用 `rsi.recipe/v1` 契约，`id`用于为 Recipe 命名。运行时可通过 CLI 的 `--id` 标识某一次实验。                                                                                                                                                |
| `application`         | `plugin` 指向已注册的 Application，`config` 按该实现的配置 Schema 填写。<br>上面示例中的 Target 和 baseline 路径相对于 Recipe 文件。                                                                                                          |
| `policy`              | `id` 指向已注册的 Policy，`config` 提供策略参数，`input` 提供初始输入。                                                                                                                                                                       |
| `bindings`            | 指定 Policy 调用的插件及其配置。<br>本例子中的Policy已经为 Agent、Proposer、Memory 和 Selector 插件实现提供默认绑定，而补充 Agent 和 Evaluator 是为了自定义自己的插件内容（当两者沿用同一插件时：对象递归合并；数组、标量和 null 替换原值；） |
| `budget`              | 设置本次实验的调用次数和时长上限。见下方各字段的计数口径和默认值。                                                                                                                                                                            |

支持环境变量引用的插件字段可使用 `${NAME}`，它与 `${{ application.initialCandidate }}` 这样的 Runtime 表达式用途不同。

### Budget

上面的 Recipe 列出了 Runtime 内置的全部五个预算字段。

| 字段               | 限制什么                                                                                                                        | 省略时                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `operations`       | Runtime 执行的操作调用次数，包括 Application 初始化、插件调用和嵌套调用。<br>一次 Policy 循环可能触发多次操作。                 | 无此项上限              |
| `evaluationRuns`   | Evaluator 启动评测的次数。一次评测可以包含多个任务。<br/>本例最多四次，分别是基线验证、训练评测、候选有修改时的验证和最终测试。 | 无此项上限              |
| `modelCalls`       | 由支持请求计量的 Agent 后端记账的请求，包括 Pi 输出纠正和子 Agent。<br/>PS：Evaluator Solver 请求由评测侧单独统计。             | 无此项上限              |
| `elapsedWallMs`    | 从实验开始计算的业务执行时长上限，单位为毫秒。<br/>恢复时沿用原开始时间计算，包含中断期间。                                     | 无 Runtime 墙钟时长上限 |
| `cleanupReserveMs` | 等待释放实例、关闭插件等清理工作的时长上限，单位为毫秒。                                                                        | 无 Runtime 清理期限     |

自定义插件还可以用 `context.charge(metric, amount)` 对自己的指标记账，并在 `budget` 中用同名键设置上限。

- 更详细的信息可参见 [Manager 的计量和超时逻辑](../../src/runtime/manager/index.ts)。

## 3. 校验、运行并查看结果

运行实验前，按 [WikiSkill 示例](../../examples/harness/dsh-wikiskill/README.md) 准备 Docker、基准任务、镜像和模型访问。

在启动 RSI 的 Shell 中设置以下变量，下面以 Bash 语法为例，PowerShell 中可用 `$env:NAME = 'value'` 设置每个变量：

```sh
export MODEL_NAME="your-optimizer-model"
export EVALUATOR_MODEL_NAME="your-solver-model"
export MODEL_ENDPOINT="https://your-model-service.example/v1"
export MODEL_API_KEY="your-api-key"
```

- RSI 不会自动加载 `.env` 文件。

- 本教程用 `MODEL_NAME` 配置优化器、用 `EVALUATOR_MODEL_NAME` 配置被评测的 Solver。仓库中的 WikiSkill Recipe 两者均使用 `MODEL_NAME`，Harness² Recipe 则分别配置。参见 [Agent 与环境变量](guides/configuration_zh.md#环境变量)。

```sh
ember-rsi catalog # List registered IDs
ember-rsi doctor my-experiment/recipe.yaml # Check configuration and runtime prerequisites
ember-rsi run my-experiment/recipe.yaml --id terminal-skills-01 # Run the experiment
ember-rsi show terminal-skills-01 # Inspect the saved status and results
```

- 用 `ember-rsi list` 查看已保存的实验。
- 用 `ember-rsi cancel terminal-skills-01` 请求取消。
- 用 `ember-rsi doctor my-experiment/recipe.yaml` 检查 Schema、绑定、契约、已声明的 Reflection 资源、本地输入和运行前提。其有时限探测可检查已缓存任务元数据、容器和模型可用性，不执行模型推理、资源下载或优化实验。
- 用 `ember-rsi run my-experiment/recipe.yaml --id terminal-skills-01 --resume` 恢复中断的实验，沿用原 Recipe、工作目录和实验 ID。
- 用 `ember-rsi dashboard --port <端口号>` 查看候选、测量和调用记录。从包含 `.rsi/` 的同一工作目录执行，并打开命令输出的地址。`Reflection & Memory` 页签还可检查经验与修订版本，并预览、应用 Reflection 修改；详见[工作台](guides/running-experiments_zh.md#工作台)。启动、恢复和取消仍通过 CLI 操作。

运行后应分别查看保存的实验状态、Measurement 状态与覆盖率，以及得分。参见 [实验运行与排障](guides/running-experiments_zh.md)。

## 下一步

- [了解 Recipe 如何执行](concepts/architecture_zh.md)，以及 Runtime 如何协调 Application、Policy 和插件。
- [选择内置 Policy 和组件](guides/built-in-components_zh.md)，匹配你的优化目标和评测环境。
- [配置实验](guides/configuration_zh.md)，了解 Recipe 字段、插件绑定、Agent 与环境变量及预算。
- [使用 doctor 诊断实验](guides/doctor_zh.md)，了解内置检查、报告含义和自定义组件的覆盖范围。
- [运行、观察与恢复实验](guides/running-experiments_zh.md)，使用 CLI 和工作台。
- [使用 Skill](guides/using-skills_zh.md)，为个人编程 Agent、被评测的 Agent 或优化器配置 Skill。
- [配置 Memory](guides/memory_zh.md)，整理执行经验并传给后续优化调用。
- [配置 Reflection](guides/reflection_zh.md)，根据执行证据改进插件，并将插件修订版本用于当前或后续实验。
- 调优推理服务参数：参见[网格搜索](../../examples/artifacts/inference/parameter-grid/README.md)或 [Optuna](../../examples/artifacts/inference/parameter-tpe/README.md) 示例。
- 优化 Triton-Ascend 算子：参见[算子优化示例](../../examples/artifacts/kernel/transpose-copy/README.zh-CN.md)，了解 NPU 环境、Recipe 与评测配置。
- [编写 Policy](guides/writing-policies_zh.md)，调整实验流程或停止条件。
- [编写并注册插件](guides/writing-plugins_zh.md)，供 Policy 调用。
- [订阅或发布 Runtime 事件](guides/runtime-events_zh.md)，在扩展中观察实验进度或发布自定义事件。
