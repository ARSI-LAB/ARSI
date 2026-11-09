# 内置组件

[English](built-in-components.md) | 简体中文 · [快速入门](../getting-started_zh.md)

本指南介绍内置 Policy 和插件的用途及搭配，帮助你为实验选择合适的组件。

可通过以下命令查看当前可用的组件：

- `ember-rsi catalog`：列出已注册的插件和 Policy ID。
- `ember-rsi list plugins`：查看插件描述、契约及输入、输出和配置 Schema。
- `ember-rsi list policies`：查看 Policy 描述、Schema、所需契约及符合契约的插件。

内置注册定义见[内置注册表](../../../src/runtime/builtins.ts)。在使用时需要内置组件时注意：契约匹配表示接口兼容，选择插件时还需确认其功能是否适合当前任务。

## Policy

按优化需求选择内置 Policy，具体配置和运行方式见对应 README：

| Policy                                                         | 适用场景                                             | 使用说明                                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `policy.harness2`（[论文](https://arxiv.org/abs/2610.14224)）  | 尝试多种 Agent 改进方案，按最终交付质量选择结果。    | [README](../../../examples/harness/dsh-harness2/README.md)                  |
| `policy.wikiskill`（[论文](https://arxiv.org/abs/2608.27454)） | 根据训练任务的经验持续改进 Agent 的 Skill。          | [README](../../../examples/harness/dsh-wikiskill/README.md)                 |
| `policy.gepa` | 通过反馈驱动的变异和种群搜索优化模块化提示词。 | [README](../../../examples/harness/dsh-gepa/README.md) |
| `policy.parameter-grid`                                        | 逐一尝试预设参数组合，选择更好的推理服务配置。       | [README](../../../examples/artifacts/inference/parameter-grid/README.md)    |
| `policy.parameter-optuna`                                      | 利用评测反馈搜索参数，在有限预算内优化推理服务性能。 | [README](../../../examples/artifacts/inference/parameter-tpe/README.md)     |
| `policy.operator-search`                                       | 结合正确性检查与性能反馈，优化 Triton-Ascend 算子。  | [README](../../../examples/artifacts/kernel/transpose-copy/README.zh-CN.md) |

## Loop 组件

| 角色        | 内置组件                                        | 用途                                                                  | 常用场景                                     |
| ----------- | ----------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| Application | [`application.agentbundle`](#application)       | 管理 Agent Bundle 的文件版本和运行实例。                              | 优化提示词、Skill 和 Agent 代码。            |
| Application | [`application.inference`](#application)         | 管理推理服务的配置版本和运行实例。                                    | 调整批处理、并发等服务参数。                 |
| Application | [`application.kernel`](#application)            | 管理 Triton-Ascend 算子源码版本和评测工作目录。                       | 优化 NPU 算子代码。                          |
| Proposer    | `proposer.agent`                                | 根据优化目标和执行证据调用模型修改文件。                              | 改进提示词、Skill 或代码。                   |
| Proposer    | `proposer.operator`                             | 根据源码分析、评测或性能分析结果生成、修复和总结算子修改。            | 迭代改进算子实现。                           |
| Proposer    | `proposer.grid`                                 | 按预设取值逐一生成参数组合。                                          | 取值有限、组合较少的参数搜索。               |
| Proposer    | `proposer.optuna`                               | 通过 Optuna 提出参数组合并接收评测反馈。                              | 在有限预算内逐步调优。                       |
| Search | `search.prompt-evolution` | 通过反馈提案、Pareto 采样和基于血缘的交叉演化提示词模块。 | 根据训练与验证任务的反馈优化提示词。 |
| Evaluator   | `evaluator.agentbench`                          | 运行 Agent 基准任务并保存得分与执行证据。                             | 检验提示词、Skill 或代码修改的效果。         |
| Evaluator   | `evaluator.inferencebench`                      | 对推理服务执行基准测试，测量吞吐量、延迟等指标。                      | 比较不同服务配置的性能。                     |
| Evaluator   | `evaluator.operatorbench`                       | 通过 Evaluator SDK 检查算子正确性、测量耗时，并按需采集性能分析数据。 | 判断算子修改是否正确、是否更快。             |
| Selector    | `selector.metric`                               | 按指定指标及约束比较候选。                                            | 依据成功率、吞吐量或延迟等数值选择更优版本。 |
| Selector    | `selector.artifact`                             | 让模型按评审标准比较匿名展示的报告等交付内容。                        | 按内容质量选择候选。                         |
| Agent 后端  | [`agent.pi`](configuration_zh.md#pi-后端)       | 通过 Pi 执行提案生成、内容评审和经验总结等任务。                      | 使用自选模型服务驱动优化流程。               |
| Agent 后端  | [`agent.codex`](configuration_zh.md#codex-后端) | 通过本机 Codex 执行提案生成、内容评审和经验总结等任务。               | 复用已有的 Codex 登录和配置。                |

## Application

Application 根据初始内容创建候选版本，检查并提交修改，并为评测准备和释放运行实例。`application.agentbundle` 管理 Agent Bundle，`application.inference` 管理推理服务配置与实例，`application.kernel` 管理 Triton-Ascend 算子源码与评测工作目录。算子基线中的 `input.py` 需要定义 `kernel_function`，环境与配置见[算子优化示例](../../../examples/artifacts/kernel/transpose-copy/README.zh-CN.md)。

### 修改范围（Target）

这一节配置的是：**优化时允许修改哪些文件、允许哪些操作，以及文件大小和一次提交的上限**。内置 `application.agentbundle`、`application.inference` 和 `application.kernel` 用 Target 文件保存这些规则。

在 Recipe 中通过 `application.config.target.schema` 指定规则文件：

```yaml
# Recipe excerpt
application:
  plugin: application.agentbundle
  config:
    target: { schema: ./target.yaml }
    baseline: { directory: ./baseline }
```

这里的 `baseline` 是初始文件目录，`target.yaml` 定义允许的修改。具体定义与准备方式见快速入门中的 [Baseline](../getting-started_zh.md#baseline) 和 [Target](../getting-started_zh.md#target)。

| 要限制什么         | Target 字段                                                  | 填写方式                                                       |
| ------------------ | ------------------------------------------------------------ | -------------------------------------------------------------- |
| 哪些文件可以改     | `entries[].path`、`entries[].kind`、`entries[].include`      | 指定文件或目录，以及目录内的匹配规则，如只匹配 `*/SKILL.md`。  |
| 允许哪些操作       | `entries[].changes`                                          | 从 `create`、`modify`、`delete` 中选择允许的操作。             |
| 哪些文件必须保护   | `protected`                                                  | 列出禁止修改的文件或路径模式，如 `bundle.yaml`、`agent.yaml`。 |
| 单个文件可以多大   | `entries[].content.maxBytes`                                 | 按字节设置文件大小上限。                                       |
| 一次提交可以改多少 | `constraints.maxChangedFiles`、`constraints.maxChangedBytes` | 分别限制变更文件数和这些文件的内容总大小（字节）。             |

Application 在提交新候选前检查实际文件改动，超出范围、包含未授权操作或超过已配置上限时，会拒绝这次提交。文件大小、变更文件数和总内容大小的上限按需填写，省略时 Target 不设置对应上限。具体规则见[文件修改检查实现](../../../src/plugins/shared/file-application/target.ts)。

## 自进化组件

### Memory

Memory 需要 Policy 显式接入。Policy 调用 `memory.agent` 将证据和观察整理成可复用经验，保存返回的 `memoryRef`，再传给后续使用经验的步骤。例如：

- **WikiSkill**：每轮训练评测后，用测评中的训练分数和执行证据更新经验，再传给本轮 Proposer，辅助改进 Skill。
- **Harness²**：每个任务结束后，用执行过程中的执行轨迹更新经验，供后续任务的 Proposer 使用；

更新失败时，Policy 可以继续。更详细的信息可见 [Memory 使用指南](memory_zh.md)。

### Reflection

Reflection 只需要 Policy 显式声明执行。在 Reflection配置文件中 指定允许修改的指导文件等资源，随后在Policy中声明 `type: reflection` 步骤调用 `reflection.agent`，根据执行证据提出修改。例如：

- **Harness²**：已授权修改 Invariant Proposer 和 Domain Proposer 的 `guidance` 指导文件。`improve_guidance` 步骤默认注释；在自定义 Policy 中启用后，可更新这些文件，供后续 Proposer 生成提案时使用。

通过校验的修改由 Runtime 在当前实验中启用，供后续插件调用读取使用。具体配置、资源授权和跨实验复用见 [Reflection 使用指南](reflection_zh.md)。
