# 编写 Policy

[English](writing-policies.md) | 简体中文 · [快速入门](../getting-started_zh.md)

Policy 使用 `rsi.policy/v1`，Recipe 使用 `rsi.recipe/v1`。Policy 声明输入、输出和配置 Schema、依赖的契约 ID、可选的默认绑定，以及执行流程。参考 [Harness²](../../../src/policies/harness2/policy.yaml)、[WikiSkill](../../../src/policies/wikiskill/policy.yaml) 和 [Policy 编译器实现](../../../src/runtime/compiler/)。

| 原语      | 行为                                                        |
| --------- | ----------------------------------------------------------- |
| `use`     | 调用依赖绑定，或显式配置的 `reflection` 模块。              |
| `state`   | 持久化状态更新，并行分支不能修改共享状态。                  |
| `if`      | 执行条件分支。                                              |
| `foreach` | 使用稳定且唯一的键、有界并发和可选的 `yield` 结果进行遍历。 |
| `loop`    | 执行嵌套循环；顶层循环支持 `maxIterations` 和 `while`。     |
| `control` | 执行 `break`、`continue`，或附带原因的 `fail`。             |

`init`、`loop` 和 `finish` 组织生命周期阶段。`${{ input.candidateRef }}`、`${{ loop.propose.output.candidateRef }}` 等表达式通过支持的表达式语言和纯函数连接数据，不执行任意 JavaScript。Recipe 的路径与 ID 仍需满足所选实现的要求。

典型搜索流程先初始化当前最优候选及其验证测量，再提案、仅评测发生修改的候选、按指标选择、在接受时更新状态，最后在 `finish` 中报告独立测试测量。Reflection 需要显式的串行 `use: reflection` 步骤，不应放入并行分支。

## 写一个基线评测 Policy

先从最短的数据流开始。将下面的 Policy 保存为 `my-extension/policy.yaml`。它复用 Application 生成的候选，只调用一次 AgentBench Evaluator，并输出测量引用。随后可以在 `init` 中保存基线测量，在 `loop` 中逐步增加提案、比较与接受逻辑。

```yaml
schemaVersion: rsi.policy/v1
id: policy.baseline-check
config_schema:
  type: object
  properties:
    taskIds:
      type: array
      minItems: 1
      items: { type: string, minLength: 1 }
  required: [taskIds]
  additionalProperties: false
input_schema:
  type: object
  properties:
    candidateRef: { type: string, minLength: 1 }
  required: [candidateRef]
  additionalProperties: false
output_schema:
  type: object
  properties:
    measurementRef: { type: string, minLength: 1 }
  required: [measurementRef]
  additionalProperties: false
input:
  candidateRef: ${{ application.initialCandidate }}
require:
  evaluator:
    contract: contract.agentbench
finish:
  steps:
    - id: evaluate
      use: evaluator
      with:
        candidateRef: ${{ input.candidateRef }}
        taskIds: ${{ config.taskIds }}
output:
  measurementRef: ${{ finish.evaluate.output.measurementRef }}
```

使用[快速入门](../getting-started_zh.md)的 Application 和 Evaluator 绑定，将 Recipe 的整个 `policy` 区块改为 `ref: policy.baseline-check` 和 `config: { taskIds: [terminal-bench/formal-crypto] }`。Policy 已声明初始候选的默认输入。

## 注册 Policy

从构建后的扩展注册自定义 Policy（下列路径相对于扩展模块）：

```js
import { fileURLToPath } from 'node:url';
import { readPolicy } from 'ember-rsi';

export async function register(registry) {
  const file = fileURLToPath(new URL('./policy.yaml', import.meta.url));
  const policy = await readPolicy(file, registry);
  registry.registerPolicy(String(policy.definition.id), file);
}
```

读取依赖自定义契约的 Policy 前，先注册相应插件定义。Recipe 引用已注册的 Policy ID，并提供全部必需绑定。修改源码后运行 `pnpm build`；工程验证使用现有 `pnpm check` 入口。真实模型和基准实验与确定性检查分别进行。
