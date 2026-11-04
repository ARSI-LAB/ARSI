# 内置组件

[English](built-in-components.md) | 简体中文 · [快速入门](../getting-started_zh.md)

用 `ember-rsi catalog` 查看当前构建注册了哪些组件。Recipe 将 Policy 槽位绑定到具体插件，Policy 声明实现必须满足的契约。注册列表和调用 Schema 分别见 [内置注册表](../../../src/runtime/builtins.ts) 和 [公共契约](../../../src/contracts/plugin-types/index.ts)。

`ember-rsi list plugins` 和 `ember-rsi list policies` 提供描述、输入/输出/配置 Schema、contract 及兼容绑定位置。兼容表示 contract 匹配，不保证适用于当前任务。`ember-rsi list` 仍列出实验，`ember-rsi catalog` 仍返回简洁的 ID 列表。

## Loop 组件

| 角色 | 内置 ID | 职责 |
| --- | --- | --- |
| Application | `application.agentbundle`、`application.inference` | 按 Target 初始化和提交候选，获取与释放 Bundle 实例或远端推理服务。 |
| Proposer | `proposer.agent`、`proposer.grid`、`proposer.optuna` | 通过模型提议文件修改、枚举参数网格，或向 Optuna 请求参数试验。 |
| Evaluator | `evaluator.agentbench`、`evaluator.inferencebench` | 通过 Evaluator SDK 测量 Agent 或推理候选。保存的测量记录包含状态、覆盖率、指标和证据引用。 |
| Selector | `selector.metric`、`selector.artifact` | 按指标及可选约束比较完整且可比的测量，或用 Agent 比较匿名交付物。 |
| Agent 后端 | `agent.pi`、`agent.codex` | 执行 Proposer、交付物 Selector、Memory 和 Reflection 发出的模型请求。两种后端各有配置 Schema 与运行前提。 |

根据要优化的目标以及可用的评测方式选择内置 Policy。

| Policy | 适用场景 |
| --- | --- |
| [`policy.harness2`](../../../examples/harness/dsh-harness2/README.md) | 对每个任务执行基线、不变性、领域和组合四类探测并选择交付物。`k` 控制各类探测的探索槽位数，`concurrency` 限制 Policy 分支并发。四类探测全部跑完时，每个任务的每个槽位对应四次评测调用。 |
| [`policy.wikiskill`](../../../examples/harness/dsh-wikiskill/README.md) | 从训练证据改进 Bundle Skill，用验证分数决定是否接受修改，最终报告独立测试集结果。 |
| [`policy.parameter-grid`](../../../examples/artifacts/inference/parameter-grid/README.md) | 枚举有限参数空间，依据实测性能选择满足约束的服务配置。 |
| [`policy.parameter-optuna`](../../../examples/artifacts/inference/parameter-tpe/README.md) | 在预算内根据测量反馈调整后续参数试验。 |

Agent 绑定配置优化器和其他由 Agent 驱动的组件。Evaluator 的服务配置独立控制基准任务的 Solver。参见 [Pi 配置 Schema](../../../src/plugins/agent-pi/schema.ts) 和 [Codex 配置 Schema](../../../src/plugins/agent-codex/schema.ts)。

## 自进化组件

### Memory

`memory.agent` 将授权证据和观察归纳成可复用的经验产物。Policy 保存返回的 `memoryRef`，并传给支持此输入的后续步骤。WikiSkill 使用 `training-summary` 学习，并区分训练、验证与独立测试。Harness² 使用 `execution`，由 `policy.config.memory` 控制是否执行 Memory 步骤。

### Reflection

`reflection.agent` 为 Reflection 配置中授权的资源提出修订。Policy 通过显式的串行 `use: reflection` 步骤调用它。内置 Harness² Policy 已声明 Reflection 配置，`improve_guidance` 步骤默认处于注释状态。在自己的 Policy 中添加显式调用即可运行。Runtime 校验、持久化并在实验中激活接受的修订。后续调用需要加载并使用修订后的资源，才会受到影响。证据、授权资源和跨实验复用的配置见 [Reflection 使用指南](reflection_zh.md)。
