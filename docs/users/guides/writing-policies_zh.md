# 编写 Policy

[English](writing-policies.md) | 简体中文 · [快速入门](../getting-started_zh.md)

本指南介绍如何编写 Policy 的 Schema、依赖绑定和执行步骤，并注册到 Runtime 供 Recipe 使用。

Policy 使用 `rsi.policy/v1`，Recipe 使用 `rsi.recipe/v1`。Policy 声明输入、输出和配置 Schema、依赖的契约 ID、可选的默认绑定，以及执行流程。参考 [Harness²](../../../src/policies/harness2/policy.yaml)、[WikiSkill](../../../src/policies/wikiskill/policy.yaml) 和 [Policy 编译器实现](../../../src/runtime/compiler/)。

所有步骤放在一个有序的顶层 `steps` 数组中，每步都声明 `id` 和 `type`。使用共享状态的 Policy 需要声明 `state_schema` 和初始 `state`，初始表达式可读取已校验的 `input`、`application` 和 `config`。

| 类型         | 行为                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `invoke`     | 调用 `require` 中声明、由 `use` 指定的绑定，通过 `with` 传入动态输入。                         |
| `state`      | 原子校验并提交共享状态更新，并行分支不能写共享状态。                                           |
| `if`         | 选择形如 `{ steps, output? }` 的 `then` 或 `else` 区块。                                       |
| `foreach`    | 用稳定且唯一的 `key` 遍历，以 `as` 命名当前项，可设置 `concurrency`（默认 1）及单项 `output`。 |
| `loop`       | 通过必填的 `maxIterations`、可选的 `while` 和 `output` 执行 `steps`。                          |
| `control`    | 执行 `break`、`continue`，或附带原因的 `fail`。                                                |
| `reflection` | 串行调用已声明的 Reflection 模块。                                                             |

`${{ input.candidateRef }}`、`${{ steps.propose.output.candidateRef }}` 等表达式必须占据整个标量，通过纯表达式语言连接数据，不执行任意 JavaScript。已完成步骤通过词法作用域中的 `steps` 解析，`loop.index` 表示最近一层循环的索引。`maxIterations` 的结果必须是 0 到 100,000 的整数。if/foreach 的输出在局部区块中求值，loop 的输出在循环外求值。如果后续步骤需要每轮结果，应存入已声明状态，并处理零轮的情况。状态更新表达式读取更新前的状态。

典型搜索先测量基线，在循环中提案并评测发生修改的候选，按指标选择并保存接受的状态，最后通过后续普通步骤评测独立测试任务。并行 foreach 分支通过输出交给串行步骤汇总。Reflection 使用 `type: reflection`，不能在并行分支执行。绑定选择插件；不存在子 Policy 或固定的 `init`/`finish` 阶段。成功、异常和取消时均由 Runtime 管理清理。

## 写一个基线评测 Policy

先从最短的数据流开始。将下面的 Policy 保存为 `my-extension/policy.yaml`。它复用 Application 生成的候选，只调用一次 AgentBench Evaluator，并输出测量引用。需要时再向 `steps` 数组增加提案、比较与接受步骤。

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
steps:
  - id: evaluate
    type: invoke
    use: evaluator
    with:
      candidateRef: ${{ input.candidateRef }}
      taskIds: ${{ config.taskIds }}
output:
  measurementRef: ${{ steps.evaluate.output.measurementRef }}
```

使用[快速入门](../getting-started_zh.md)的 Application 和 Evaluator 绑定，并移除其他绑定：该 Policy 只声明了 `evaluator`。将 Recipe 的整个 `policy` 区块替换为：

```yaml
policy:
  id: policy.baseline-check
  config:
    taskIds: [terminal-bench/formal-crypto]
```

Policy 已声明初始候选的默认输入。先注册它，再校验 Recipe。

## 注册 Policy

从构建后的扩展注册自定义 Policy（下列路径相对于扩展模块）：

```js
import { fileURLToPath } from 'node:url';
import { Policy } from 'ember-rsi';

export async function register(registry) {
  const file = fileURLToPath(new URL('./policy.yaml', import.meta.url));
  const policy = await Policy.load(file, registry);
  registry.registerPolicy(policy.id, file);
}
```

读取依赖自定义契约的 Policy 前，先注册相应插件定义。Recipe 引用已注册的 Policy ID，并提供全部必需绑定。修改源码后运行 `pnpm build`；工程验证使用现有 `pnpm check` 入口。真实模型和基准实验与确定性检查分别进行。

将注册模块保存为 `my-extension/index.mjs`，并在每个需要此 Policy 的 CLI 进程中加载：

```sh
ember-rsi validate my-experiment/recipe.yaml --plugin-dir ./my-extension
ember-rsi run my-experiment/recipe.yaml --id baseline-01 --plugin-dir ./my-extension
```

仅创建 YAML 文件不会注册 Policy。修改未完成实验使用的定义之前，参见 [扩展加载](writing-plugins_zh.md#为-cli-注册外部扩展) 和 [实验恢复](running-experiments_zh.md#取消与恢复)。
