# 编写插件

[English](writing-plugins.md) | 简体中文 · [快速入门](../getting-started_zh.md)

本指南介绍如何选择插件契约、定义配置、编写业务逻辑，以及注册插件并在 Policy 和 Recipe 中使用。

**插件提供具体能力，Policy 决定何时调用，Recipe 选择实现并提供配置。** 如果只是调整模型、任务或提示词，先查看[配置指南](configuration_zh.md)；需要改变执行步骤时，查看[编写 Policy](writing-policies_zh.md)。当都满足不了时，可以考虑编写定制插件。

## 选择公共契约

根据插件要完成的工作选择契约。契约规定调用的输入和输出，插件负责具体实现及其配置。已有契约符合需求时，直接复用对应的契约对象和类型：

| 契约与字段定义                                                                           | 用途                                         | 导入的契约对象             |
| ---------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------- |
| [contract.application](../../../src/contracts/plugin-types/application.ts)               | 管理优化目标、提交候选、获取和释放运行实例。 | `applicationContract`      |
| [contract.agent](../../../src/contracts/plugin-types/agent.ts)                           | 执行模型请求与工具调用。                     | `agentContract`            |
| [contract.proposer](../../../src/contracts/plugin-types/proposer.ts)                     | 根据目标和证据生成候选。                     | `proposerContract`         |
| [contract.proposer-operator](../../../src/contracts/plugin-types/proposer-operator.ts)   | 修改、修复算子并整理优化历史。               | `operatorProposerContract` |
| [contract.agentbench](../../../src/contracts/plugin-types/agentbench.ts)                 | 按任务列表评测候选。                         | `agentbenchContract`       |
| [contract.inferencebench](../../../src/contracts/plugin-types/inferencebench.ts)         | 评测推理应用候选。                           | `inferencebenchContract`   |
| [contract.operatorbench](../../../src/contracts/plugin-types/operatorbench.ts)           | 检查算子正确性、测量性能或收集性能分析数据。 | `operatorbenchContract`    |
| [contract.selector-metrics](../../../src/contracts/plugin-types/selector-metrics.ts)     | 比较测量指标并选择候选。                     | `metricSelectorContract`   |
| [contract.selector-artifacts](../../../src/contracts/plugin-types/selector-artifacts.ts) | 按给定标准比较候选内容并选择候选。           | `artifactSelectorContract` |
| [contract.memory](../../../src/contracts/plugin-types/memory.ts)                         | 将证据和观察整理成可复用的经验。             | `memoryContract`           |
| [contract.reflection](../../../src/contracts/plugin-types/reflection.ts)                 | 根据执行证据提出插件修订。                   | `reflectionContract`       |
| [contract.proposer-grid](../../../src/contracts/plugin-types/proposer-grid.ts)           | 按网格搜索顺序生成参数候选。                 | `gridProposerContract`     |
| [contract.search](../../../src/contracts/plugin-types/search.ts)                         | 管理有状态搜索、请求工作并接收反馈。         | `searchContract`           |

每个普通插件只实现一个公共契约。Application 等契约包含多种动作，由同一个 `execute` 按 `input.action` 区分。

- 输入、输出类型及 Schema 见表中的定义文件，插件只需声明自己的配置 Schema。

Policy 的 `require` 指定所需契约，绑定时需要选择满足该契约的插件。这样可以为同一 Policy 更换实现；概念说明见[Contract、Schema 与 Binding](../concepts/architecture_zh.md#contractschema-与-binding)。

## 插件定义包含什么

`OperationDefinition<I, O, C>` 描述插件定义，三个类型参数分别是输入、输出和配置，详见[接口定义](../../../src/contracts/operation.ts)。

| 字段                   | 含义                                           | 填写方式                                                                             |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `id`                   | 插件实现的唯一 ID，供绑定选择。                | 必填，如 `proposer.keep-parent`；不能与已注册的插件或 Policy 重名。                  |
| `description`          | 说明插件的用途。                               | 可选，填写简短说明。                                                                 |
| `contract`             | 声明插件遵循的公共契约。                       | 必填，填写导入的契约对象，如 `proposerContract`。                                    |
| `configSchema`         | 校验该实现的配置。                             | 必填，填写 JSON Schema；没有配置时也声明对象 Schema。                                |
| `create`               | 根据配置创建插件实例。                         | 必填，填写异步函数 `create(config, context)`，返回含 `execute` 和 `dispose` 的对象。 |
| `implementationDigest` | 标识实现版本，恢复实验时用于检查实现是否变化。 | 可选，填写覆盖实际实现代码的摘要；代码变化时更新。                                   |

- 省略 `implementationDigest` 时，Registry 根据 `create` 函数文本、契约和配置 Schema 生成摘要。

### configSchema

**`configSchema` 声明插件接受哪些配置，以及这些配置该怎么填。** 插件作者用它规定字段名、类型、必填项和默认值；使用者在 Policy 或 Recipe 的 `config` 中填写具体值。

- 例如，下方插件要求 `reason` 是必填的非空字符串，使用者可以填写 `config: { reason: 'Keep the parent candidate.' }`。缺少 `reason` 或填成数字时，Runtime 会在加载 Recipe 时报告配置错误；校验通过后，插件通过 `create(config, context)` 读取 `config.reason`。

下表列出编写 `configSchema` 时常用的规则字段；

| Schema 字段                          | 含义                                       | 写法示例                                                         |
| ------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------- |
| `type`                               | 指定值的类型。                             | `type: 'object'`；允许空值时可用 `type: ['string', 'null']`。    |
| `properties`                         | 定义对象有哪些字段及其类型。               | `properties: { reason: { type: 'string' } }`。                   |
| `required`                           | 指定必须提供的字段。                       | `required: ['reason']`；仅写在 `properties` 中不会使字段必填。   |
| `additionalProperties`               | 控制是否允许未声明的字段。                 | 通常填 `false`，使拼错或未知的字段在校验时报错。                 |
| `default`                            | 在省略字段时补默认值。                     | `default: 1`；值须符合该字段的类型。                             |
| `enum` / `const`                     | 限定可选值或固定值。                       | `enum: ['maximize', 'minimize']` / `const: 'retain-incumbent'`。 |
| `minimum` / `maximum`                | 限定数值范围。                             | `type: 'integer', minimum: 1`。                                  |
| `minLength` / `pattern`              | 限定字符串长度或格式。                     | `type: 'string', minLength: 1`。                                 |
| `items` / `minItems` / `uniqueItems` | 指定数组元素类型、最少数量及是否允许重复。 | `items: { type: 'string' }, minItems: 1, uniqueItems: true`。    |
| `oneOf`                              | 定义只能满足其中一种的结构。               | 填写 Schema 数组，常用于按 `action` 区分输入和输出。             |
| `x-rsi-path`                         | 标记配置中的文件或目录路径。               | 在字符串字段上填写 `'x-rsi-path': 'file'` 或 `'directory'`。     |

Runtime 合并 Policy 和 Recipe 的配置后，补齐默认值、校验配置，并将结果传给 `create`。

- 标记了 `x-rsi-path` 的相对路径按声明配置的文件定位：

- 插件也可以支持从环境变量读取配置。例如，`agent.pi` 的 `api_key` 可以这样填写：

  ```yaml
  # agent.pi 的 config 片段
  api_key: ${MODEL_API_KEY}
  ```

  启动 CLI 前执行 `export MODEL_API_KEY='your-api-key'`，运行时 `agent.pi` 会读取该变量作为密钥。自定义插件要支持这种写法，也需要实现环境变量读取逻辑；在 Schema 中声明 `type: 'string'` 只会检查字段类型。

### create 的返回对象

表中的 `create(config, context)` 用校验后的配置初始化插件，并返回一个对象，这个对象称为**插件实例**。

Runtime 每次调用插件时，执行该对象的 `execute(input, context)`；同一对象可以重复使用，不再使用时调用 `dispose()` 释放资源。各方法的职责如下：

| 方法                                | 作用                                         | 写法                                                                                |
| ----------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `execute(input, context)`           | 完成一次业务调用。                           | 必需，异步返回符合公共契约的输出；`input` 是本次调用的数据。                        |
| `dispose()`                         | 释放实例持有的进程、连接和监听器等长期资源。 | 必需，异步完成清理；没有资源时可为空实现。                                          |
| `canRetry(input, receipt, context)` | 确认失败或取消的调用是否可以安全重放。       | 可选，通过只读检查确认重放不会重复副作用时才返回 `true`；不用于重放效果未知的调用。 |

## 示例：编写并使用一个最小 Proposer

这个插件始终保留父候选，用于验证注册和调用流程，不需要模型。

- 它使用 `contract.proposer` 的三个必需输入：`parent` 是父候选引用，`goal` 是本次目标，`evidenceRefs` 是证据引用数组，可以为空。返回 `status: no-change`，并通过 `rationale` 说明原因。

### 第一步：编写插件

下面以已安装 `ember-rsi` 的 TypeScript ESM 工程为例，将三个文件放在 `src/proposer-keep-parent/`，编译到 `dist/proposer-keep-parent/`。

#### 1. 定义配置

在 `schema.ts` 中定义配置类型和校验规则。本例要求提供非空的 `reason`：

```ts
import type { JsonSchema } from 'ember-rsi/contracts';

// 插件配置及其校验规则。
export type KeepParentConfig = { reason: string };

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    reason: { type: 'string', minLength: 1 },
  },
  required: ['reason'],
  additionalProperties: false,
};
```

#### 2. 编写业务逻辑

在 `service.ts` 中返回插件实例。`execute` 接收本次调用的输入和 RuntimeContext，`dispose` 负责实例清理：

```ts
import type {
  Operation,
  ProposerInput,
  ProposerOutput,
  RuntimeContext,
} from 'ember-rsi/contracts';
import type { KeepParentConfig } from './schema.js';

export async function createKeepParent(
  config: KeepParentConfig,
  _context: RuntimeContext,
): Promise<Operation<ProposerInput, ProposerOutput>> {
  return {
    // 检查取消信号和父候选，返回保留父候选的结果。
    async execute(input, context): Promise<ProposerOutput> {
      context.signal.throwIfAborted();
      await context.readCandidate(input.parent);
      return {
        status: 'no-change',
        candidateRef: input.parent,
        diffRef: null,
        rationale: config.reason,
      };
    },
    // 本例没有需要释放的长期资源。
    async dispose(): Promise<void> {},
  };
}
```

#### 3. 组装插件定义

在 `index.ts` 中填写实现 ID，将契约、配置 Schema 和 `create` 函数组合成定义：

```ts
import {
  proposerContract,
  type OperationDefinition,
  type ProposerInput,
  type ProposerOutput,
} from 'ember-rsi/contracts';
import { configSchema, type KeepParentConfig } from './schema.js';
import { createKeepParent } from './service.js';

export const keepParentDefinition: OperationDefinition<
  ProposerInput,
  ProposerOutput,
  KeepParentConfig
> = {
  id: 'proposer.keep-parent',
  description: 'Keep the parent candidate without edits.',
  contract: proposerContract,
  configSchema,
  create: createKeepParent,
};
```

### 第二步：注册插件

Runtime 通过注册 ID 查找插件。创建文件或在 Recipe 中填写 ID 都不会自动加载代码，需要针对新增的插件进行注册操作。

> 维护框架内置插件时，也可将实现放在 `src/plugins/`，在[内置注册文件](../../../src/runtime/builtins.ts)中注册，并执行 `pnpm build` 随框架构建。

1. 使用自定义插件工程自己的构建命令生成 `dist/proposer-keep-parent/`，将编译结果及运行时依赖部署到 `~/.ember-rsi/plugins/my-extension/`，保留相对目录结构。

2. 在`~/.ember-rsi/plugins/my-extension/`下创建 `index.mjs`，导出 `register(registry)`：

   ```js
   import { keepParentDefinition } from './dist/proposer-keep-parent/index.js';

   export function register(registry) {
     registry.registerOperation(keepParentDefinition);
   }
   ```

3. CLI 启动时会自动按目录名称顺序扫描 `~/.ember-rsi/plugins/` 的直接子目录，加载各目录的 `index.mjs` 并调用 `register(registry)`。
   - 放在此处的扩展无需额外参数；一个入口可以注册多个插件和 Policy，已有入口时将代码加入现有的 `register` 即可。

   - 扩展也可以保留在项目目录或其他位置，通过 `--plugin-dir ./my-extension` 显式加载；
     - 该选项应指向包含 `index.mjs` 的扩展目录，相对路径以命令的工作目录为准。
     - CLI 先加载用户级扩展，再按参数顺序加载 `--plugin-dir` 指定的目录；

#### 需要新契约时

如果现有契约都不适用，可通过 `defineContract({ id, input_schema, output_schema })` 定义新契约，让插件的 `contract` 指向该对象，并在自定义 Policy 的 `require` 中填写新契约 ID。

`registerOperation(definition)` 会同时注册插件及其契约；也可用 `registerContract(contract)` 单独注册契约。

- 加载 Policy 前需完成注册，同一契约 ID 的 Schema 必须一致。Policy 的注册步骤见[编写 Policy](writing-policies_zh.md#注册-policy)。

### 第三步：在 Policy 和 Recipe 中使用

#### 1. 在 Policy 中声明绑定和调用

绑定名由 Policy 自行声明，步骤通过 `use` 选择绑定。下面用 `proposer` 作为绑定名，`propose` 作为步骤 ID，结果可通过 `steps.propose.output` 读取。

下面是 Policy 片段，需放入[完整的 Policy](writing-policies_zh.md)并注册。已有 Policy 声明了相应契约的绑定时，直接在 Recipe 中选择插件即可：

```yaml
# 声明 proposer 绑定需要的公共契约。
require:
  proposer:
    contract: contract.proposer

# 提供默认插件和配置，Recipe 可以覆盖。
defaults:
  bindings:
    proposer:
      plugin: proposer.keep-parent
      config:
        reason: Keep the baseline for this demonstration.

# 调用插件，传入父候选、目标和证据引用。
steps:
  - id: propose
    type: invoke
    use: proposer
    with:
      parent: ${{ application.initialCandidate }}
      goal: Check the plugin integration.
      evidenceRefs: []
```

#### 2. 在 Recipe 中选择插件和配置

Recipe 的 `bindings` 使用 Policy 声明的绑定名。下面为 `proposer` 选择实现并填写配置：

```yaml
bindings:
  proposer:
    plugin: proposer.keep-parent
    config:
      reason: Keep the parent in this experiment.
```

省略 `plugin` 时沿用 Policy 的默认实现；更换实现时，新插件必须满足该绑定的契约。`config` 按所选插件的 Schema 填写，缺少必填项会导致校验失败。合并和覆盖规则见[配置指南](configuration_zh.md#recipe-字段与绑定覆盖)。

#### 3. 校验并运行

扩展已放在 `~/.ember-rsi/plugins/my-extension/` 时，在包含 `my-experiment/` 的工作目录直接使用已安装的 CLI：

```sh
ember-rsi doctor my-experiment/recipe.yaml
ember-rsi run my-experiment/recipe.yaml --id custom-run
```

如果扩展保存在工作目录下的 `my-extension/` 等其他位置，校验、运行和恢复时都传入同一扩展目录：

```sh
ember-rsi doctor my-experiment/recipe.yaml --plugin-dir ./my-extension
ember-rsi run my-experiment/recipe.yaml --id custom-run --plugin-dir ./my-extension
```

`doctor` 检查契约、绑定和配置，再对已选择的实现运行可用的内置前提探测。没有随 RSI 打包检查脚本的自定义插件会标为 `unchecked`。Doctor 不执行模型推理或优化实验；Evaluator 委托完整 SDK doctor，包括其下载和构建探针。实验运行后检查 `propose` 的输出是否包含 `status: no-change` 和预期的 `rationale`；查看步骤结果的方法见[运行与检查实验](running-experiments_zh.md)。

## 使用 RuntimeContext

Runtime 将 `context` 传给 `create` 和每次 `execute`。插件通过它读取候选、保存结果、调用其他插件和响应取消，完整接口见[上下文字段](../../../src/contracts/runtime/execution.ts)与[服务接口](../../../src/contracts/runtime/services.ts)。

| 需要做什么         | 使用的字段或方法                                         | 作用                                                                     |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| 识别当前调用       | `experimentId`、`callId`、`bindingId`、`idempotencyKey`  | 获取实验、调用、绑定及幂等标识；幂等键可传给支持幂等写入的外部服务。     |
| 响应取消           | `signal`、`cleanup`                                      | 业务操作使用 `signal`；取消后的资源释放使用独立的 `cleanup` 信号。       |
| 读取候选           | `readCandidate(ref)`                                     | 返回候选记录，包括保存其内容的 `artifactRef`。                           |
| 登记候选           | `recordCandidate(artifactRef, parentRef)`                | 返回候选引用，通常由 Application 在检查修改范围后调用。                  |
| 读取或保存测量     | `readMeasurement(ref)`、`recordMeasurement(measurement)` | 读取测量记录；保存时按公共协议校验并返回测量引用。                       |
| 保存或读取内容     | `artifacts.putJson/readJson`、`capture/materialize`      | 保存和读取 JSON，或保存目录内容并还原到本地目录。                        |
| 在临时目录中编辑   | `workspaces.create/read/release`                         | 创建或读取工作区，使用其 `directory` 编辑文件，并在结束时释放。          |
| 调用 Application   | `application(input)`、`applicationMetadata()`            | 执行生命周期动作，或读取目标、能力和初始候选等元数据。                   |
| 使用候选的运行实例 | `withInstance(candidateRef, capability, use)`            | 获取实例、执行 `use(execution)`，并协调实例释放。                        |
| 调用其他绑定       | `invoke(bindingName, input)`                             | 经过 Runtime 的契约校验、预算检查、调用记录和修订选择。                  |
| 调用 Agent         | `invokeAgent(agentRef, input)`                           | 按 `agentRef` 选择 Recipe 绑定，把 `input` 交给 Agent。                  |
| 读取证据           | `readEvidence(refs, options?)`                           | 按需选择 `view`、文件或 JSON 格式及 `maxBytes`，取得本次允许读取的证据。 |
| 记录用量           | `charge(metric, amount)`                                 | 记录用量并检查预算，调用时必须 `await`。                                 |
| 订阅事件           | `event`                                                  | 监听运行事件，结束时取消订阅；见 [Runtime 事件](runtime-events_zh.md)。  |

在 `execute` 中，使用 `ember-rsi` 导出的 `prepareAgentProject` 创建受 Runtime 管理的工作目录。第二个参数传指令，第三个参数传授权的文本文件，最后两个参数分别传 Skill 目录和角色定义。每次独立调用都应准备工作目录。同一次插件执行内，如果多个 Agent 调用需要隔离本地修改，需提供不同的项目内容。

```ts
import { prepareAgentProject } from 'ember-rsi';

const cwd = await prepareAgentProject(
  context,
  'Read context/input.json and return your findings.',
  { 'context/input.json': JSON.stringify({ target: 'example' }) },
  [],
  [],
);
const result = await context.invokeAgent('agent', {
  cwd,
  goal: 'Inspect the target',
  outputSchema: { type: 'object' },
});
```

### 调用与资源清理

- 加载 Recipe 时只装配定义；运行时再调用 `create` 创建实例、调用 `execute` 执行业务。Runtime 负责校验输入输出并记录调用。
- 同一实例可服务多次调用，也可能被并行调用。每次调用的数据和临时资源放在本次调用内，使用当前 `execute` 收到的上下文；`create` 收到的上下文用于实例资源。
- 将取消信号传给外部请求和耗时操作。调用创建的工作区、文件及临时进程在 `finally` 中释放；长期资源在 `dispose` 中释放。`create` 返回前失败时，自行清理已经创建的资源。

## 在宿主程序中使用

除 CLI 外，也可以在自己的程序中创建 Runtime 并注册插件。下面假定已经准备好完整的 `policy.my-search` 文件和引用它的 Recipe：

```ts
import { resolve } from 'node:path';
import { createRuntime, Recipe } from 'ember-rsi';
import { keepParentDefinition } from './my-extension/dist/proposer-keep-parent/index.js';

// 创建 Runtime，关闭用户级扩展加载，直接注册所需定义。
const runtime = await createRuntime({
  rootDirectory: process.cwd(),
  homeDirectory: false,
});
try {
  runtime.registry.registerOperation(keepParentDefinition);
  runtime.registry.registerPolicy(
    'policy.my-search',
    resolve('./my-extension/policy.yaml'),
  );

  // Assemble the Recipe with structural validation, then run it with the same Runtime.
  const recipePath = resolve('./my-experiment/recipe.yaml');
  const recipe = await Recipe.load(recipePath, runtime.registry);
  console.log(recipe.id);
  const result = await runtime.manager.run(recipePath, { id: 'custom-run' });
  console.log(result.status, result.output);
} finally {
  await runtime.dispose();
}
```

`createRuntime` 的常用选项如下，完整选项见 [Runtime 入口](../../../src/runtime/context.ts)。这些是宿主 API 参数。

| 选项                | 含义                                             | 缺省时                   |
| ------------------- | ------------------------------------------------ | ------------------------ |
| `rootDirectory`     | 宿主工作根目录。                                 | 当前进程目录。           |
| `directory`         | 保存 Runtime 数据的目录。                        | 工作根目录下的 `.rsi/`。 |
| `homeDirectory`     | 用户级扩展主目录；填 `false` 可禁用自动加载。    | `~/.ember-rsi`。         |
| `pluginDirectories` | 额外加载的扩展目录数组，路径相对于当前进程目录。 | 不加载额外目录。         |

宿主中的注册只对该 Runtime 生效。另行启动 CLI 时，将扩展放入默认用户级目录自动加载，或使用 `--plugin-dir` 指定扩展目录。

`Recipe.load` 装配并检查定义的结构，不执行前提探测。需要 CLI 预检时，使用相同的扩展注册运行 `ember-rsi doctor`。自定义插件自动参与结构和路径检查，目前没有公开的自定义探针接口，详见[自定义组件如何接入 doctor](doctor_zh.md#4-自定义组件如何接入-doctor)。
