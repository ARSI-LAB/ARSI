# 检查和检视拉取请求

[English](ci-review.md) | 简体中文 · [快速开始](../getting-started_zh.md)

## 提 PR 之前

在源码检出目录运行 `pnpm install --frozen-lockfile`，再运行 `pnpm check`。检查覆盖格式、ESLint、导入边界、插件布局、文档、TypeScript、单元测试和构建。修改指南时同步更新两种语言。TypeScript 代码块会对照包的公开类型编译。用 `ts file=example.ts` 关联同一指南内的多个代码块，用 `ts ignore-check` 标注伪代码。

要检查当前分支所有已提交的文档改动，运行 `node scripts/check-docs.mjs --base origin/master --head HEAD`。

登录 Codex CLI 后，可运行 `pnpm review:local` 检视本地改动。命令会从获取到的 `origin/master` 读取检视配置，并将结果输出到终端。在 PR 中说明验证结果、影响范围和回退步骤。

## 远端检查

GitHub 在预合并版本上运行 `L1-Fast`。当差异非空，且所有改动都位于 `docs/` 或根目录的 Markdown 文件中时，执行文档检查。两个 Heavy 任务会跳过依赖安装和测试，向 GitHub 上报成功。修改 `src/`、`.github/`、`examples/` 或 `skills/` 下的 Markdown，以及空差异，都会触发完整检查。完整快速检查通过后，`L1-Heavy / test-windows` 执行 Windows 单元测试。涉及打包输入时，`L1-Heavy / package` 验证独立消费者安装。桥接工作流的改动还会执行其 Python 测试。合并队列使用同样的三个任务。

## 启动维护者 Worker

使用维护者控制的专用检出目录，让 `origin` 指向接收 PR 的仓库。按锁文件安装依赖，并登录 Codex CLI 和 GitHub CLI。外层 Worker 需要读取 Actions、发布 PR 评论和解决检视线程的 GitHub 权限。运行一个 `pnpm review:worker` 进程并保持运行，使用 Ctrl+C 停止。要对指定 PR 检查一次，可运行：

```sh
pnpm review:worker --once --repo ARSI-LAB/ARSI --pr 123
```

Worker 检查当前提交上的快速任务是否通过。仓库成员的 PR 自动进入检视。外部贡献者的 PR 由维护者添加 `ai-review` 标签或评论 `/ai-review`。检视使用可信基线上的提示词、相关指南及已发布的团队检视 Skill。Codex 以原生只读沙箱检查临时工作树，外层 Worker 负责发布结果。

Codex 子进程继承 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及其小写形式，使用默认 Codex 提供方和 CLI 登录凭据。Worker 会传入 `--ignore-user-config`，用户配置中的自定义提供方、MCP 服务和钩子不会加载。

汇总评论记录已检视的 SHA、轮次和复核结果。经复核的 Important 问题可以在新增行、删除行或可见上下文行上建立行内线程。Nit 和 Pre-existing 只进入汇总，可引用已修改文件的其他行。作者可以在行内线程回复修复措施或理由。

新提交触发增量检视，范围为上次已检视提交之后的改动及原有开放线程。若 amend、rebase 或合入基线后，上次提交已脱离当前 PR 的增量范围，Worker 会重新检视当前 PR 的完整差异。每轮都按整个 PR 的变更文件选择指南。三轮后，维护者可用 `--pr 123 --manual` 检视新的提交。`[needs-human]` 表示需要维护者裁定。后续某次检视跳过时，汇总评论会在上次已完成的检视结果上方列出本次尝试的 SHA。AI 检视被跳过或工作站离线时，由人工完成完整检视。

## 设置合并门禁

GitHub 出现检查名称后，由仓库维护者为 `master` 配置规则集，要求上述三项 L1 检查通过、一名人工批准、新提交使旧批准失效、所有对话已解决，并禁止强推和删除。启用首次贡献者工作流审批、合并队列和 squash 合并。由人工批准并加入队列。L2 通过 GitHub 的 COMMENT 事件发布检视意见，作为辅助检视。
