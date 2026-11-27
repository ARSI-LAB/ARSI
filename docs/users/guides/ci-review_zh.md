# 检查和检视拉取请求

[English](ci-review.md) | 简体中文 · [快速开始](../getting-started_zh.md)

## 提 PR 之前

在源码检出目录运行 `pnpm install --frozen-lockfile`，再运行 `pnpm check`。检查覆盖格式、ESLint、导入边界、插件布局、文档、TypeScript、单元测试和构建。修改指南时同步更新两种语言。TypeScript 代码块会对照包的公开类型编译。用 `ts file=example.ts` 关联同一指南内的多个代码块，用 `ts ignore-check` 标注伪代码。

登录 Codex CLI 后，可运行 `pnpm review:local` 检视本地改动。命令会从获取到的 `origin/master` 读取检视配置，并将结果输出到终端。在 PR 中说明验证结果、影响范围和回退步骤。

## 远端检查

GitHub 在预合并版本上运行 `L1-Fast`。纯文档改动只执行 Markdown 格式和文档检查。涉及桥接工作流的改动还会执行其 Python 测试。快速检查通过后，`L1-Heavy / test-windows` 执行 Windows 单元测试，涉及打包输入的变更由 `L1-Heavy / package` 验证独立消费者安装。合并队列使用同样的三个任务。

## 启动维护者 Worker

使用维护者控制的专用检出目录，让 `origin` 指向接收 PR 的仓库。按锁文件安装依赖，并登录 Codex CLI 和 GitHub CLI。外层 Worker 需要读取 Actions、发布 PR 评论和解决检视线程的 GitHub 权限。运行一个 `pnpm review:worker` 进程并保持运行，使用 Ctrl+C 停止。要对指定 PR 检查一次，可运行：

```sh
pnpm review:worker --once --repo ARSI-LAB/ARSI --pr 123
```

Worker 检查当前提交上的快速任务是否通过。仓库成员的 PR 自动进入检视。外部贡献者的 PR 由维护者添加 `ai-review` 标签或评论 `/ai-review`。检视使用可信基线上的提示词、相关指南及已发布的团队检视 Skill。Codex 以原生只读沙箱检查临时工作树，外层 Worker 负责发布结果。

汇总评论记录已检视的 SHA、轮次和复核结果。经复核的 Important 问题会建立行内线程，作者可以回复修复措施或理由。新提交触发增量检视，同时检查原有开放线程。三轮后，维护者可用 `--pr 123 --manual` 检视新的提交。`[needs-human]` 表示需要维护者裁定。AI 检视被跳过或工作站离线时，由人工完成完整检视。

## 设置合并门禁

GitHub 出现检查名称后，由仓库维护者为 `master` 配置规则集，要求上述三项 L1 检查通过、一名人工批准、新提交使旧批准失效、所有对话已解决，并禁止强推和删除。启用首次贡献者工作流审批、合并队列和 squash 合并。由人工批准并加入队列。L2 通过 GitHub 的 COMMENT 事件发布检视意见，作为辅助检视。
