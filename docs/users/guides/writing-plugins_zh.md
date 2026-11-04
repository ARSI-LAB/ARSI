# 编写插件

[English](writing-plugins.md) | 简体中文 · [快速入门](../getting-started_zh.md)

## 选择扩展边界

| 需求                                               | 扩展方式                                            |
| -------------------------------------------------- | --------------------------------------------------- |
| 修改任务、限制、模型或现有提示词路径               | 覆盖对应的 Recipe 配置或绑定。                      |
| 替换推理和工具执行，复用 Proposer 的证据与编辑处理 | 实现 `contract.agent` 并替换 `agent` 绑定。         |
| 替换完整的提案流程                                 | 实现 `contract.proposer` 并替换对应 Proposer 绑定。 |
| 修改编排、状态或停止规则                           | 注册自定义 Policy。                                 |

绑定在绑定与配置层合并，不进行任意递归合并。替换嵌套配置时请核对 [加载器](../../../src/runtime/loaders/index.ts)。`ref` 选择已注册实现，不会导入文件或注册代码。

插件按 `schema.ts`（配置）、`service.ts`（业务逻辑与清理）、`index.ts`（组装定义）组织，复用公共契约的输入输出 Schema。仓库内插件导入本地契约；外部工程从 `ember-rsi` 或 `ember-rsi/contracts` 导入，不使用私有 `src/*` 子路径。

自定义 Agent 必须返回符合请求中 `input.outputSchema` 的对象，限制可用工具和文件，传递取消信号，以 `context.charge('modelCalls', 1)` 为实际模型尝试记账，并释放资源。实现 Agent 契约不会自动让任意后端校验请求中的输出 Schema；后端需要执行该校验。内置 Proposer 的编辑协议见 [共享编辑代码](../../../src/plugins/shared/agent-editing/index.ts)。

## 实现插件生命周期

1. 在[公共契约](../../../src/contracts/plugin-types/index.ts)中找到目标 Policy 槽位要求的契约，并复用其输入输出类型。在 `schema.ts` 中定义插件配置，描述默认值与约束。
2. 在 `service.ts` 中实现 `create(config, context)`，返回 `execute(input, context)` 和 `dispose()`。通过调用的 `RuntimeContext` 读取候选和证据、提交修改或记录测量。在外部调用中传递取消信号，并清理本次调用拥有的资源。
3. 在 `index.ts` 中组装 `OperationDefinition`，将唯一的实现 ID、公共契约、配置 Schema 与工厂函数连在一起。Policy 的 `require` 使用契约 ID，Recipe 的绑定 `ref` 使用实现 ID。

例如，指标选择器将 `selector.metric` 注册为 `contract.selector-metrics` 的实现。其 `execute` 读取两个测量引用，检查可比性并保存选择记录。可对照[插件定义](../../../src/plugins/selector-metrics/index.ts)、[配置 Schema](../../../src/plugins/selector-metrics/schema.ts)和[实现](../../../src/plugins/selector-metrics/service.ts)。需要提交文件修改时，可参考 [Skill 的确定性 Proposer 示例](../../../skills/ember-rsi/assets/minimal/extension/operations.mjs)，它通过 Application 提交候选，并在 `finally` 中释放工作区。

## 为 CLI 注册外部扩展

默认扩展从 `~/.ember-rsi/plugins/<name>/index.mjs` 按名称顺序加载，之后加载额外的 `--plugin-dir` 目录。主目录不存在时正常启动；已发现的扩展无效时启动失败。实验数据仍在工作目录的 `.rsi/`。嵌入宿主可设置 `homeDirectory: false` 隔离本机扩展。

所有 CLI 命令都接受可重复的 `--plugin-dir <directory>`。每个目录包含 ESM 文件 `index.mjs`，导出 `register(registry)`。扩展及其依赖必须提前构建，并能在加载时被解析：

```js
// my-extension/index.mjs
import { myAgentDefinition } from './agent.js';

export function register(registry) {
  registry.registerOperation(myAgentDefinition);
}
```

在 Recipe 中设置 `bindings.agent.ref: agent.my-custom`，与插件定义 ID 一致；需要扩展的命令都传入该目录：

```sh
ember-rsi validate ./my-recipe/recipe.yaml --plugin-dir ./my-extension
ember-rsi run ./my-recipe/recipe.yaml --id custom-run --plugin-dir ./my-extension
```

仓库内置扩展则需将定义加入 [registerBuiltins](../../../src/runtime/builtins.ts) 并重新构建。仅创建源码文件不会注册插件。

## 嵌入 Runtime

外部宿主可以直接注册定义。校验和执行所用 Runtime 必须具有相同的注册内容：

```ts
import { resolve } from 'node:path';
import { createRuntime, validateRecipe } from 'ember-rsi';
import { myAgentDefinition } from './plugins/agent-custom/index.js';

const runtime = await createRuntime({ rootDirectory: process.cwd() });
try {
  runtime.registry.registerOperation(myAgentDefinition);
  const recipePath = resolve('./my-recipe/recipe.yaml');
  const check = await validateRecipe(runtime, recipePath);
  console.log(check);
  const result = await runtime.manager.run(recipePath, { id: 'custom-run' });
  console.log(result.status, result.output);
} finally {
  await runtime.dispose();
}
```

宿主进程直接注册插件，不会修改另行启动的 CLI 进程。请通过该宿主管理实验，或通过 `--plugin-dir` 加载相同扩展。不要将存活的 `RuntimeContext` 对象作为 JSON 持久化。
