# 快速入门

[English](getting-started.md) | 简体中文

> 进行下列操作前，先按 [仓库说明](../../README.zh-CN.md) 安装依赖、构建 ember-rsi 并安装 CLI。

本例从定义 Application 开始，限制可修改的文件，再使用内置 Policy 编写一个改进终端任务 Skill 的 Recipe。

- 通过本例来快速展示 RSI 框架如何完成基础使用。

pnpm 会按锁定的 `ember-evaluator` 依赖安装并构建 Evaluator SDK，代码也使用该名称导入。参见 [package.json](../../package.json)。

## 1. 定义 Application

优化 Agent Harness 时可以选用内置的 `application.agentbundle`，只需要填写：

- **Baseline** 提供实验开始时的 Agent Bundle。
- **Target** 规定 Application 可以接受哪些文件修改。

### Baseline

Baseline 就是你已经能运行、想拿来改进的那一版 Agent。实验启动时，`application.agentbundle`对 Baseline 目录生成快照，校验 Bundle 和 Skill，然后把快照登记为第一个候选。

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
    ├── prompts/terminal-discipline.md
    └── skills/completion-checks/SKILL.md
```

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

写自己的 Baseline 时，把原始 Agent Bundle 的清单、入口配置、依赖锁和插件文件一起放进目录。检查清单引用的相对路径都存在，并确认插件会加载你希望改进的提示词或 Skill。最后在 Recipe 中把 `application.config.baseline.directory` 指向这个目录，路径相对于 `recipe.yaml`。已有可访问的 Bundle 快照时，也可以改用 `baseline.artifactRef`。两种来源二选一。

### Target

创建 `my-experiment/target.yaml`。本例只允许在 Baseline 的 `plugins/terminal-base/skills/` 下新建、修改或删除各 Skill 的 `SKILL.md`。

```yaml
schemaVersion: rsi.target/v1
id: target.my-terminal-skills
entries:
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

将下面内容保存为 `my-experiment/recipe.yaml`，与 `target.yaml` 和 `baseline/` 放在同一目录。

- 本示例使用`policy.wikiskill` ，该 Policy 从训练任务集学习，用验证任务集评测基线及发生修改的候选，并在搜索结束后评测测试任务集。

```yaml
schemaVersion: rsi.recipe/v1
id: my-terminal-skills
application:
  ref: application.agentbundle
  config:
    target: { schema: ./target.yaml }
    baseline: { directory: ./baseline }
policy:
  ref: policy.wikiskill
  input:
    candidateRef: ${{ application.initialCandidate }}
  config:
    maxRounds: 1
    dataset:
      trainTaskIds: [terminal-bench/html-js-filter]
      validationTaskIds: [terminal-bench/formal-crypto]
      testTaskIds: [terminal-bench/bun-sourcemap-leak]
bindings:
  evaluator:
    ref: evaluator.agentbench
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

| 字段 | 用法 |
| --- | --- |
| `schemaVersion`、`id` | 使用 `rsi.recipe/v1` 契约，并为 Recipe 命名。运行时通过 CLI 的 `--id` 标识某一次实验。 |
| `application` | `ref` 指向已注册的 Application，`config` 按该实现的配置 Schema 填写。示例中的 Target 和 baseline 路径相对于 Recipe 文件。 |
| `policy` | `ref` 指向已注册的 Policy，`config` 提供策略参数，`input` 提供初始输入。 |
| `bindings` | 将 Policy 槽位映射到已注册的插件 ID 及其静态配置。WikiSkill 已提供默认绑定 Agent、Proposer、Memory 和 Selector的设定，Recipe 可以不修改其默认设置，只补充 Evaluator的设定（**同一个 `ref` 按配置顶层键合并**）。 |
| `budget` | 设置本次实验的调用次数和时长上限。见下方各字段的计数口径和默认值。 |
| `reflection`（可选） | 对已声明并显式调用 Reflection 的 Policy，可用 `{ configFile: ./reflection.yaml }` 替换 Policy 指定的 Reflection 配置文件。 |

支持环境变量引用的插件字段可使用 `${NAME}`，它与 `${{ application.initialCandidate }}` 这样的 Runtime 表达式用途不同。参见 [Recipe 加载器](../../src/runtime/loaders/index.ts) 和 [WikiSkill 配置 Schema](../../src/policies/wikiskill/schemas/wikiskill-config.yaml)。

### Budget

上面的 Recipe 列出了 Runtime 内置的全部五个预算字段。

| 字段 | 限制什么 | 省略时 |
| --- | --- | --- |
| `operations` | Runtime 执行的操作调用次数，包括 Application 初始化、插件调用和嵌套调用。一次 Policy 循环可能触发多次操作。 | 无此项上限 |
| `evaluationRuns` | Evaluator 启动评测的次数。一次评测可以包含多个任务。本例最多四次，分别是基线验证、训练评测、候选有修改时的验证和最终测试。 | 无此项上限 |
| `modelCalls` | 优化器等组件通过 RSI 的 Agent 后端发起并记账的模型请求次数。评测任务内 Solver 发出的请求由评测侧统计。 | 无此项上限 |
| `elapsedWallMs` | 从实验开始计算的业务执行时长上限，单位为毫秒。恢复实验时沿用原开始时间计算剩余时长。 | `86400000`（24 小时） |
| `cleanupReserveMs` | 等待释放实例、关闭插件等清理工作的时长上限，单位为毫秒。Runtime 为清理单独计算期限。 | `60000`（1 分钟） |

三个计数字段接受非负安全整数，两个时长字段接受 `1` 到 `4294967295` 的整数。自定义插件还可以用 `context.charge(metric, amount)` 对自己的指标记账，并在 `budget` 中用同名键设置上限。额外的键只有在有调用按该名称记账时才会生效。参见 [Manager 的计量和超时逻辑](../../src/runtime/manager/index.ts)。

## 3. 校验、运行并查看结果

运行实验前，按 [WikiSkill 示例](../../examples/harness/dsh-wikiskill/README.md) 准备 Docker、基准任务、镜像和模型访问。

在启动 RSI 的 Shell 中设置以下变量。下方使用 Bash 语法。PowerShell 中可用 `$env:NAME = 'value'` 设置每个变量。

```sh
export MODEL_NAME="your-optimizer-model"
export EVALUATOR_MODEL_NAME="your-solver-model"
export MODEL_ENDPOINT="https://your-model-service.example/v1"
export MODEL_API_KEY="your-api-key"
```

```sh
ember-rsi catalog # 查看已注册 ID
ember-rsi validate my-experiment/recipe.yaml # 检查配置、契约和绑定
ember-rsi run my-experiment/recipe.yaml --id terminal-skills-01 #执行实验
ember-rsi show terminal-skills-01 # # 查看已记录的运行状态和结果。
```

- 用 `ember-rsi list` 查看已保存的实验
- 用 `ember-rsi cancel terminal-skills-01` 请求取消。
- 恢复中断的实验时，在原命令末尾加 `--resume`，并沿用 Recipe、工作目录和实验 ID。
- 从同一工作目录执行 `ember-rsi serve --port 4317`，即可在 `http://127.0.0.1:4317` 查看已保存的候选、测量和调用记录。

## 下一步

- [了解 Recipe 如何执行](concepts/architecture_zh.md)，以及 Runtime 如何协调 Application、Policy 和插件。
- [选择内置 Policy 和组件](guides/built-in-components_zh.md)，匹配你的优化目标和评测环境。
- [使用 Skill](guides/using-skills_zh.md)，为编程助手、被评测的 Agent 或优化器配置 Skill。
- [配置 Reflection](guides/reflection_zh.md)，在实验中修订指导资源，或将已保存的修订应用到后续实验。
- [调优推理服务参数](guides/parameter-search_zh.md)，使用网格搜索或 Optuna。
- [编写 Policy](guides/writing-policies_zh.md)，调整实验流程或停止条件。
- [编写并注册插件](guides/writing-plugins_zh.md)，为 Policy 槽位提供新的实现。
- [订阅或发布 Runtime 事件](guides/runtime-events_zh.md)，在扩展中观察实验进度或发布自定义事件。
