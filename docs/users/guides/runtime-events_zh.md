# 事件系统开发指南

[English](runtime-events.md) | 简体中文 · [快速入门](../getting-started_zh.md) · [Reflection](reflection_zh.md)

本指南介绍如何订阅内置事件、发布自定义事件，并在插件生命周期中管理监听与清理。

插件可通过 `RuntimeContext.event` 使用事件系统：在 `create(config, ctx)` 中注册监听，在 `execute(input, ctx)` 或监听回调中发布事件、调用服务。

从 `ember-rsi/contracts` 导入 `RuntimeContext`。

## 1. 内置事件一览

内置事件由框架在对应执行位置自动发布，插件直接订阅即可。

| 事件                            | 发布时机                                          | 分发方式    |
| ------------------------------- | ------------------------------------------------- | ----------- |
| `rsi/before-experiment`         | Application 初始化或恢复执行之前                  | `serial`    |
| `rsi/experiment-started`        | 实验的 `running` 记录保存后，根 Policy 执行前     | `emit`      |
| `rsi/experiment-finished`       | 关闭新业务调用并保存实验终态后                    | `parallel`  |
| `rsi/before-call`               | 输入、预算检查和运行中回执保存后，实际插件 调用前 | `waterfall` |
| `rsi/call-succeeded`            | 输出校验、成功回执保存后，返回插件 调用结果前     | `parallel`  |
| `rsi/call-failed`               | 失败回执保存后，报告插件 原始错误前               | `parallel`  |
| `rsi/call-cancelled`            | 取消回执保存后，报告插件 取消前                   | `parallel`  |
| `rsi/call-unknown`              | 插件执行结果未确认的回执保存后                    | `parallel`  |
| `rsi/policy-started`            | 输入、配置和恢复身份校验后，Policy 执行首个步骤前 | `serial`    |
| `rsi/policy-step-completed`     | Policy 中新执行步骤的检查点保存后                 | `emit`      |
| `rsi/policy-boundary-completed` | Loop/Policy 执行边界的检查点保存后                | `serial`    |
| `rsi/policy-completed`          | Policy 最终输出校验后                             | `emit`      |
| `rsi/candidate-recorded`        | candidate 保存后                                  | `emit`      |
| `rsi/measurement-recorded`      | measurement 校验并保存后                          | `emit`      |
| `rsi/revision-activated`        | 激活记录保存、有效绑定及已有插件实例的订阅切换后  | `emit`      |

四种分发方式：

- `emit`：发布方不等待异步监听。表中的普通通知监听失败只记录诊断，已保存的事实不回滚；同步抛错可能中断后续监听。
- `parallel`：等待监听处理完成。`rsi/call-succeeded` 的监听失败可以使后续流程失败，但成功回执不变；其他调用结果和实验终态通知的监听失败只记录诊断。
- `serial`：依次等待监听完成。表中使用 `serial` 的三个事件只能返回 `undefined` 或 `Promise<undefined>`；抛错会阻止后续流程。
- `waterfall`：用于 `rsi/before-call`，监听链返回准入决策，Manager 根据最终结果决定是否执行调用。

事件参数只携带身份和必要引用。常用字段如下，完整类型见[事件契约](../../../src/contracts/runtime/events.ts)：

| 字段                                         | 含义                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `experimentId`、`recipeId`                   | 所属实验与 Recipe；`recipeId` 来自 `recipe.id`，三个实验事件都携带它 |
| `resumed`                                    | 是否从已保存状态恢复执行                                             |
| `callId`、`parentCallId`、`path`             | 被观察的调用、上层调用及流程中的执行位置                             |
| `bindingId`、`bindingRef`、`revisionRef`     | 实验中的绑定名、绑定指向的插件、调用使用的修订引用                   |
| `policyId`、`policyScopeId`、`checkpointRef` | Policy 定义、本次逻辑执行身份及检查点引用                            |
| `stepPath`                                   | Policy 步骤或循环轮次边界的位置；步骤不携带固定生命周期阶段标签      |
| `candidateRef`、`measurementRef`             | 已保存的候选或测量引用；成功调用事件中的 `measurementRef` 是可选字段 |

## 2. 监听内置事件

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

## 3. 声明、监听和发布自定义事件

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

该模块要包含在发布方和监听方的 TypeScript 编译范围中。

在 `create(config, factoryCtx)` 中订阅：

```ts
factoryCtx.event.on('demo/proposal-ready', (event) => {
  console.log(event.candidateRef);
});
```

在 `execute(input, ctx)` 中，候选准备好后发布；`candidateRef` 为实际候选引用：

```ts
await ctx.event.parallel('demo/proposal-ready', {
  experimentId: ctx.experimentId,
  candidateRef,
});
```

同一实验内已经激活的实例都可以订阅此事件。自定义事件按自身约定选择 `emit`、`parallel`、`serial`、`bail` 或 `waterfall`，并明确参数和返回类型。

## 4. 通过业务调用触发内置事件

在 `execute` 或监听回调中，使用当前执行的上下文调用公共服务。以下参数应按实际业务准备：

```ts
const result = await ctx.invoke('evaluator', evaluationInput);
const candidateRef = await ctx.recordCandidate(artifactRef, parentCandidateRef);
```

第一行由 Manager 在实际调用前发布 `rsi/before-call`，保存调用结果后发布对应结果事件。第二行保存候选后发布 `rsi/candidate-recorded`。Application 的生命周期动作也使用通用调用事件。

## 5. 使用时注意

- **实例激活后才接收事件。**注册插件定义和配置 binding 不会启动监听；实例按需创建，不补收历史事件。较晚创建的插件不会收到实验启动通知。
- **按来源筛选。**监听中发起的业务调用也会产生事件，使用 binding 等条件过滤，避免递归触发自身。
- **终态监听只做收尾。**`rsi/experiment-finished` 中可以读取记录、刷新日志、释放本地资源，不能再启动受控业务调用。
- **恢复不会重放已完成通知。**复用成功调用回执、恢复已完成步骤或已有事实时，不重放对应事件；重复幂等写入仍可能产生记录通知。
- **订阅由 Runtime 清理。**插件自行持有的文件、连接等资源，仍需由插件的 `dispose()` 释放。
