# 事件系统开发指南

[English](runtime-events.md) | 简体中文 · [快速入门](../getting-started_zh.md) · [Reflection](reflection_zh.md)

本指南介绍如何订阅内置事件、发布自定义事件，并在插件生命周期中管理监听与清理。

**插件可通过 `RuntimeContext.event` 使用事件系统：在 `create(config, ctx)` 中注册监听，在 `execute(input, ctx)` 或监听回调中发布事件、调用服务。**

## 1. 四种分发方式

| 方式        | 含义                                                           | 举例                                                                              |
| ----------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `emit`      | 发布事件后继续执行，不等待异步监听完成。                       | `rsi/candidate-recorded`：候选保存后通知插件更新统计。                            |
| `parallel`  | 并发执行监听，并等待异步监听完成。                             | `rsi/experiment-finished`：等待监听刷新日志、释放本地资源。                       |
| `serial`    | 按顺序执行监听，前一个完成后再执行下一个；抛错会阻止后续流程。 | `rsi/before-experiment`：依次执行实验启动前的检查。                               |
| `waterfall` | 按监听链处理准入决策，Manager 根据最终结果决定是否执行调用。   | `rsi/before-call`：按 binding 判断是否允许调用，返回 `proceed` 或 `reject` 决策。 |

- 内置 `serial` 事件的监听只能返回 `undefined` 或 `Promise<undefined>`。返回 `true`、`0`、字符串或对象等值，会提前结束本次事件分发，跳过后续监听；

## 2. 内置事件一览

内置事件由框架在对应执行位置自动发布，插件直接订阅即可。下表说明监听函数第一个参数 `event` 的完整字段：每个事件都包含所属分组的通用参数，再加上事件表列出的专用参数。未标 `?` 的字段均必填；`?` 表示可以省略，`string | null` 表示字段存在但值可为 `null`。所有字段只读，类型定义见[事件契约](../../../src/contracts/runtime/events.ts)。

普通监听接收 `(event, ctx)`，`rsi/before-call` 接收 `(event, next, ctx)`。`ctx` 是本次监听的 `RuntimeContext`；`next: () => Promise<CallDecision>` 用于继续后续监听并取得准入决策，详见[监听内置事件](#3-监听内置事件)。`ctx` 和 `next` 都不是 `event` 的字段。

### 实验生命周期

**通用参数：**

| 字段           | 类型     | 含义                             |
| -------------- | -------- | -------------------------------- |
| `experimentId` | `string` | 所属实验的 ID。                  |
| `recipeId`     | `string` | Recipe 的 ID，来自 `recipe.id`。 |

**事件与专用参数：**

| 事件                      | 发布时机                                      | 分发方式   | 专用参数                                                                                     |
| ------------------------- | --------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `rsi/before-experiment`   | Application 初始化或恢复执行之前              | `serial`   | `policyId: string`：将要执行的 Policy ID。<br>`resumed: boolean`：本次是否恢复已有实验。     |
| `rsi/experiment-started`  | 实验的 `running` 记录保存后，根 Policy 执行前 | `emit`     | `policyId: string`：本次执行的 Policy ID。<br>`resumed: boolean`：本次是否恢复已有实验。     |
| `rsi/experiment-finished` | 关闭新业务调用并保存实验终态后                | `parallel` | `status: 'succeeded' \| 'failed' \| 'cancelled'`：实验的最终状态，分别表示成功、失败或取消。 |

### 插件调用

**通用参数：**

| 字段           | 类型                                                               | 含义                                                                             |
| -------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `experimentId` | `string`                                                           | 所属实验的 ID。                                                                  |
| `callId`       | `string`                                                           | 被观察的插件调用 ID。                                                            |
| `bindingId`    | `string`                                                           | 被调用的绑定名，如 `evaluator`。                                                 |
| `parentCallId` | `string`                                                           | 发起本次调用的上层执行 ID。                                                      |
| `path`         | `string`                                                           | 调用在流程中的位置；Policy 调用通常对应步骤路径，其他调用可能使用发起方执行 ID。 |
| `bindingRef`   | `string`                                                           | 该绑定选择的插件 ID，如 `evaluator.agentbench`。                                 |
| `revisionRef`  | `string \| null`                                                   | 本次调用使用的插件修订引用；没有生效修订时为 `null`。                            |
| `status`       | `'running' \| 'succeeded' \| 'failed' \| 'cancelled' \| 'unknown'` | 本次调用的状态；`before-call` 对应 `running`，其余事件与事件名中的状态一致。     |

**事件与专用参数：**

| 事件                 | 发布时机                                         | 分发方式    | 专用参数                                                              |
| -------------------- | ------------------------------------------------ | ----------- | --------------------------------------------------------------------- |
| `rsi/before-call`    | 输入、预算检查和运行中回执保存后，实际插件调用前 | `waterfall` | 无。                                                                  |
| `rsi/call-succeeded` | 输出校验、成功回执保存后，返回插件调用结果前     | `parallel`  | `measurementRef?: string`：可选。仅当调用输出对象包含测量引用时提供。 |
| `rsi/call-failed`    | 失败回执保存后，报告插件原始错误前               | `parallel`  | 无。                                                                  |
| `rsi/call-cancelled` | 取消回执保存后，报告调用取消前                   | `parallel`  | 无。                                                                  |
| `rsi/call-unknown`   | 插件执行结果未确认的回执保存后                   | `parallel`  | 无。                                                                  |

### Policy 执行

**通用参数：**

| 字段            | 类型     | 含义                                             |
| --------------- | -------- | ------------------------------------------------ |
| `experimentId`  | `string` | 所属实验的 ID。                                  |
| `policyId`      | `string` | 执行的 Policy ID。                               |
| `policyScopeId` | `string` | Policy 的逻辑执行范围标识；当前根流程为 `root`。 |
| `checkpointRef` | `string` | 对应的 Policy 检查点记录引用。                   |

**事件与专用参数：**

| 事件                            | 发布时机                                          | 分发方式 | 专用参数                                                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rsi/policy-started`            | 输入、配置和恢复身份校验后，Policy 执行首个步骤前 | `serial` | `resumed: boolean`：是否从已保存的 Policy 检查点恢复。                                                                                                                                                                                            |
| `rsi/policy-step-completed`     | Policy 中新执行步骤的检查点保存后                 | `emit`   | `stepPath: string`：完成步骤的完整路径，如 `steps/evaluate`。                                                                                                                                                                                     |
| `rsi/policy-boundary-completed` | Loop/Policy 执行边界的检查点保存后                | `serial` | `boundary: 'iteration-completed' \| 'policy-completed'`：表示一轮循环完成或整个 Policy 执行完成。<br>`iteration?: number`：可选。从 0 开始的迭代序号，仅在循环迭代边界提供。<br>`stepPath?: string`：可选。循环步骤的路径，仅在循环迭代边界提供。 |
| `rsi/policy-completed`          | Policy 最终输出校验后                             | `emit`   | 无，只有通用参数。                                                                                                                                                                                                                                |

### 候选、测量与版本

**通用参数：**

| 字段           | 类型     | 含义            |
| -------------- | -------- | --------------- |
| `experimentId` | `string` | 所属实验的 ID。 |

**事件与专用参数：**

| 事件                       | 发布时机                                         | 分发方式 | 专用参数                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rsi/candidate-recorded`   | 候选保存后                                       | `emit`   | `callId: string`：写入该记录的调用 ID。<br>`bindingId: string`：写入该记录的绑定名。<br>`candidateRef: string`：已保存的候选引用。<br>`parentRef: string \| null`：父候选引用；初始候选为 `null`。                                                                                                                          |
| `rsi/measurement-recorded` | 测量校验并保存后                                 | `emit`   | `callId: string`：写入该记录的调用 ID。<br>`bindingId: string`：写入该记录的绑定名。<br>`measurementRef: string`：已保存的测量引用。                                                                                                                                                                                        |
| `rsi/revision-activated`   | 激活记录保存、有效绑定及已有插件实例的订阅切换后 | `emit`   | `activationId: string`：本次修订启用记录的 ID。<br>`bindingIds: readonly string[]`：本次启用修订涉及的绑定名列表。<br>`revisionRefs: Readonly<Record<string, string>>`：本次启用的修订映射，键为绑定名，值为修订引用。<br>`policyRevisionRef?: string`：可选。契约预留的 Policy 修订引用；当前 Runtime 发布该事件时不设置。 |

## 3. 监听内置事件

在插件的 `create(config, factoryCtx)` 中注册。下面监听名为 `evaluator` 的 binding，并读取它产生的测量：

```ts
factoryCtx.event.on('rsi/call-succeeded', async (event, ctx) => {
  if (event.bindingId !== 'evaluator') return;
  if (event.measurementRef === undefined) return;

  const measurement = await ctx.readMeasurement(event.measurementRef);
  console.log(event.callId, measurement);
});
```

- 将 `evaluator` 换成实际的 binding 名，它不是选择插件实现的 `plugin`。`event.callId` 是被观察的调用 ID；`ctx.callId` 是本次监听的执行 ID。

- `factoryCtx` 和 `ctx` 两者的类型都是 `RuntimeContext`，但对应不同的执行阶段。用两个名字，是为了在同一段代码里区分外层和内层变量，避免都叫 `ctx` 时内层遮蔽外层。

需要阻止某次调用时，监听准入事件：

```ts
factoryCtx.event.on('rsi/before-call', async (event, next) => {
  if (event.bindingId === 'blockedBinding') {
    return { kind: 'reject', reason: 'This binding is disabled.' };
  }
  return next();
});
```

`next()` 继续后面的监听，默认结果为 `{ kind: 'proceed' }`。Manager 使用整条链的最终决策；最终 `reject` 必须有非空原因，被调用方不会执行。需要监听上下文时，第三个参数是 `ctx`，即 `(event, next, ctx)`。

## 4. 声明、监听和发布自定义事件

先在插件的事件类型模块中扩展 Cordis `Events`，使用自己的事件命名空间。下面约定发布方使用 `parallel` 等待监听完成：

```ts
import type {} from '@deepseek-ai/cordis';

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** @mode parallel Await observers after a proposal result is ready. */
    'demo/proposal-ready'(event: {
      experimentId: string;
      candidateRef: string;
    }): void | Promise<void>;
  }
}
```

- 该模块要包含在发布方和监听方的 TypeScript 编译范围中。

在 `create(config, factoryCtx)` 中订阅：

```ts
factoryCtx.event.on('demo/proposal-ready', (event) => {
  console.log(event.candidateRef);
});
```

在 `execute(input, ctx)` 中，候选准备好后发布；

```ts
await ctx.event.parallel('demo/proposal-ready', {
  experimentId: ctx.experimentId,
  candidateRef,
});
```

同一实验内已经激活的实例都可以订阅此事件。自定义事件按自身约定选择 `emit`、`parallel`、`serial`、`bail` 或 `waterfall`，并明确参数和返回类型。

## 5. 通过业务调用触发内置事件

**插件调用 Runtime 的服务接口时，Runtime 会自动发布对应的内置事件。**下面是两个独立示例，内置事件会随服务调用自动触发。：

```ts
// 1. 下面代码调用名为 evaluator 的绑定时，调用前发布 rsi/before-call，保存结果后发布成功、失败等对应事件。
const result = await ctx.invoke('evaluator', evaluationInput);

// 2. 下面代码将文件快照登记为候选，保存存候选后发布 rsi/candidate-recorded。
const candidateRef = await ctx.recordCandidate(artifactRef, parentCandidateRef);
```

## 6. 使用时注意

- **实例激活后才接收事件。**注册插件定义和配置 binding 不会启动监听；例如，较晚创建的插件不会收到实验启动通知。
- **按来源筛选。**监听中发起的业务调用也会产生事件，记得使用 binding 等条件过滤，避免递归触发自身。
- **终态监听只做收尾。**`rsi/experiment-finished` 中可以读取记录、刷新日志、释放本地资源，不能再启动受控业务调用。
- **恢复不会重放已完成通知。**复用成功调用回执、恢复已完成步骤或已有事实时，不重放对应事件；
- **订阅由 Runtime 清理。**插件自行持有的文件、连接等资源，仍需由插件的 `dispose()` 释放。
