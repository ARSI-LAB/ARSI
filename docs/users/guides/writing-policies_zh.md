# 编写 Policy

[English](writing-policies.md) | 简体中文 · [快速入门](../getting-started_zh.md)

本指南介绍如何编写 Policy 的字段和执行步骤，以及如何注册并在 Recipe 中使用。

**Policy 决定按什么顺序调用插件、如何选择分支，以及何时结束。**

## Policy 文件包含什么

Policy 使用 `rsi.policy/v1`，与 `rsi.recipe/v1` 的 Recipe 配合使用。主要字段如下：

| 字段                  | 作用                                                                           |
| --------------------- | ------------------------------------------------------------------------------ |
| `schemaVersion`       | 指定 Policy 格式，当前内置为唯一契约 `rsi.policy/v1`。                         |
| `id`                  | Policy 的注册 ID，Recipe 通过 `policy.id` 选择它。                             |
| `description`         | 可选，用一段文字说明流程用途。                                                 |
| `config_schema`       | 定义流程参数及其类型，对应 Recipe 的 `policy.config`，如任务列表、最大轮数。   |
| `input_schema`        | 定义流程启动时需要的数据，对应 Recipe 的 `policy.input`，如初始候选引用。      |
| `input`               | 提供输入默认值，如：可引用 Application 创建的初始候选。                        |
| `require`             | 声明流程使用的绑定名及其公共契约，如 `evaluator` 需要 `contract.agentbench`。  |
| `defaults.bindings`   | 为绑定提供默认插件和配置，Recipe 可以覆盖。                                    |
| `defaults.reflection` | 通过 `configFile` 指定 Reflection 配置文件；使用 `reflection` 步骤时需要声明。 |
| `state_schema`        | 使用共享状态时，定义状态字段和类型。                                           |
| `state`               | 设置共享状态的初始值；可用表达式读取 `input`、`application` 和 `config`。      |
| `steps`               | 按顺序执行的步骤列表，每步声明 `id` 和 `type`。                                |
| `output_schema`       | 定义 Policy 最终返回结果的结构。                                               |
| `output`              | 指定返回哪些值，可读取步骤输出或共享状态。                                     |

## 步骤与数据传递

### 步骤类型

在 `steps` 中按执行顺序填写步骤。每步先声明 `id` 和 `type`，再填写下表中的参数：

| 类型         | 用途                                   | 写法                                                                                                                                                             |
| ------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoke`     | 调用插件完成一次任务。                 | `use` 填 `require` 中的绑定名，`with` 填本次调用的输入。                                                                                                         |
| `state`      | 保存共享状态，供后续步骤或下一轮读取。 | `state` 填需要更新的字段和值，可使用表达式；校验通过后整体提交，必须串行执行。                                                                                   |
| `if`         | 根据条件选择执行分支。                 | `if` 填判断条件，`then` 必填，`else` 可选；分支包含 `steps` 和可选的 `output`。                                                                                  |
| `foreach`    | 逐项处理集合，可并行执行。             | `foreach` 填集合，`as` 命名当前项，`key` 提供稳定且唯一的标识，`steps` 填每项操作；`concurrency` 限制同时处理的项数，默认 1（串行执行）；`output` 返回每项结果。 |
| `loop`       | 循环执行一组步骤。                     | `steps` 填循环内容，`maxIterations` 必填，结果为 0 到 100,000 的整数；可用 `while` 提前结束循环、用 `output` 定义返回值。                                        |
| `control`    | 退出循环、跳过当前轮或终止流程。       | `control` 填 `break`、`continue` 或 `fail`；使用 `fail` 时还需填写 `reason`。                                                                                    |
| `reflection` | 使用内置的 Reflection 自进化能力       | 步骤填 `type: reflection`，并在 `defaults.reflection` 中声明模块；必须串行执行，配置方式见 [Reflection 指南](reflection_zh.md)。                                 |

### 用表达式读取数据

字段名按相应 Schema 填写，步骤 ID 按 Policy 中的声明填写。取值示例：

```yaml
taskIds: ${{ config.taskIds }} # 配置中的任务列表
candidateRef: ${{ input.candidateRef }} # 启动输入中的候选
measurementRef: ${{ steps.evaluate.output.measurementRef }} # evaluate 步骤的输出
bestCandidateRef: ${{ state.bestCandidateRef }} # 当前共享状态
```

- 表达式须占据整个字段值，`steps` 只能引用当前区块或外层已完成的步骤。
- `application.initialCandidate` 和 `loop.index` 是框架提供的固定属性。

### 保存状态与并行执行

- 用 `state_schema` 声明字段、用 `state` 设置初始值，再通过 `state` 步骤更新。一次更新中的所有表达式都读取更新前的状态。
- 并行 `foreach` 分支通过各自的 `output` 返回结果，再由后续串行步骤汇总并更新共享状态。共享状态更新和 Reflection 步骤都只能串行执行。
  - `if` 和 `foreach` 的 `output` 在对应区块内求值；`loop` 的 `output` 在循环结束后求值。
  - 过程中需要保留的循环内数据应先存入共享状态，并为循环执行 0 次的情况准备初始值。

## 写一个基线评测 Policy

下面的 Policy 接收一个候选和任务列表，调用一次 Evaluator，然后返回测量引用。文件保存位置按下节选择的注册方式确定。

```yaml
# Policy 文件使用的协议版本。
schemaVersion: rsi.policy/v1
# 注册后的 Policy ID，Recipe 通过 policy.id 选择它。
id: policy.baseline-check

# 定义 Recipe 的 policy.config 可填写的流程参数，这里要求提供任务列表。
config_schema:
  type: object
  properties:
    taskIds:
      type: array
      minItems: 1
      items: { type: string, minLength: 1 }
  required: [taskIds]
  additionalProperties: false

# 定义流程启动所需的输入，这里是要评测的候选引用。
input_schema:
  type: object
  properties:
    candidateRef: { type: string, minLength: 1 }
  required: [candidateRef]
  additionalProperties: false

# 定义 Policy 最终返回的结果，这里是评测生成的测量引用。
output_schema:
  type: object
  properties:
    measurementRef: { type: string, minLength: 1 }
  required: [measurementRef]
  additionalProperties: false

# 提供默认输入：评测 Application 初始化时创建的候选。
input:
  candidateRef: ${{ application.initialCandidate }}

# 声明 evaluator 绑定需要的评测契约。
require:
  evaluator:
    contract: contract.agentbench

# 提供默认评测插件和 3600 秒任务超时，Recipe 可以覆盖。
defaults:
  bindings:
    evaluator:
      plugin: evaluator.agentbench
      config:
        run:
          timeoutSeconds: 3600

# 执行一次评测，将输入候选和配置的任务列表传给 evaluator。
steps:
  - id: evaluate
    type: invoke
    use: evaluator
    with:
      candidateRef: ${{ input.candidateRef }}
      taskIds: ${{ config.taskIds }}

# 返回 evaluate 步骤产生的测量引用。
output:
  measurementRef: ${{ steps.evaluate.output.measurementRef }}
```

## 注册 Policy

Recipe 通过已注册的 Policy ID 找到对应文件。内置 Policy 已由框架统一注册，可以直接使用。新增 Policy 时，需要通过已安装的 CLI 加载扩展入口进行注册。

> 维护框架内置 Policy 时，也可将文件放在 `src/policies/`，加入[内置注册文件](../../../src/runtime/builtins.ts)的 Policy 文件列表，并执行 `pnpm build` 随框架构建。

1. 将上面的示例保存为 `~/.ember-rsi/plugins/my-extension/policy.yaml`。

2. 在同一目录创建 `index.mjs`，导出 `register(registry)`，登记 Policy ID 和文件的路径：

   ```js
   import { fileURLToPath } from 'node:url';

   export function register(registry) {
     registry.registerPolicy(
       'policy.baseline-check',
       fileURLToPath(new URL('./policy.yaml', import.meta.url)),
     );
   }
   ```

3. CLI 启动时会按目录名称顺序扫描 `~/.ember-rsi/plugins/` 的直接子目录，加载各目录的 `index.mjs` 并调用 `register(registry)`，无需额外参数。
   - 注册 ID 必须与 `policy.yaml` 中的 `id` 一致；Runtime 在加载 Recipe 时读取并校验该 Policy。

   - 如果 Policy 使用自定义契约，需在加载它之前注册相应插件或契约。一个入口可以注册多个插件和 Policy；已有入口时，将注册代码加入现有的 `register` 即可。

   - **如果希望将扩展保存在项目目录或其他位置，使用 `--plugin-dir ./my-extension` 指定包含 `index.mjs` 的扩展目录。**
     - 相对路径以命令的工作目录为准，多个目录可重复使用该选项。

### 配置 Recipe 并运行

#### 第一步：在 Recipe 中选择 Policy

沿用[快速入门](../getting-started_zh.md)中的 Application，并在 Recipe 的 `bindings` 中只保留 `evaluator`。

将 Recipe 的整个 `policy` 区块替换为：

```yaml
policy:
  id: policy.baseline-check
  config:
    taskIds: [terminal-bench/formal-crypto]
```

示例 Policy 的 `input` 已默认读取 Application 的初始候选，因此这里可以省略 `policy.input`。

#### 第二步：校验并运行

扩展已放在 `~/.ember-rsi/plugins/my-extension/` 时，在包含 `my-experiment/` 的工作目录直接使用已安装的 CLI：

```sh
ember-rsi doctor my-experiment/recipe.yaml
ember-rsi run my-experiment/recipe.yaml --id baseline-01
```

如果扩展保存在工作目录下的 `my-extension/` 等其他位置，校验、运行和恢复时都传入同一扩展目录：

```sh
ember-rsi doctor my-experiment/recipe.yaml --plugin-dir ./my-extension
ember-rsi run my-experiment/recipe.yaml --id baseline-01 --plugin-dir ./my-extension
```

更多扩展加载说明见[注册插件](writing-plugins_zh.md#第二步注册插件)。修改未完成实验使用的 Policy 前，先核对[恢复要求](running-experiments_zh.md#取消与恢复)。
