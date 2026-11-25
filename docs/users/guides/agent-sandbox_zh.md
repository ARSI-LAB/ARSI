# 使用 Agent 沙箱

[English](agent-sandbox.md) | 简体中文 · [快速入门](../getting-started_zh.md)

通过 `config.sandbox` 选择单次原生 Agent 调用的文件系统写入边界。RSI 为本次调用传入设置，启用沙箱时不改写宿主机的用户级或系统级全局配置。

## 支持范围

显式档位 `read-only` 和 `workspace-write` 目前支持 Linux 上的以下后端：

| 后端        | Recipe 的 `plugin` | 环境要求                                                                                                          |
| ----------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Codex       | `agent.codex`      | 已安装 Codex CLI，支持兼容的 app-server 配置协议和原生 Linux 沙箱能力。                                           |
| Claude Code | `agent.claudecode` | 兼容的 Claude Code CLI、`bubblewrap`、`socat`，以及允许原生沙箱启动的 Linux 环境。                                |
| DSH         | `agent.dsh`        | 已安装 `@deepseek-ai/dsh` CLI，具有原生 base/headless、沙箱、文件系统和 Shell 组件，并能完整执行 Linux 沙箱约束。 |

先按[配置实验](configuration_zh.md)安装所选 CLI 并配置模型访问。平台或原生能力不兼容时，显式档位会失败，RSI 不会自动降级到更宽松的档位。

设置作用于 RSI 通过对应 Agent 绑定发起的调用。Proposer、Memory 和 Reflection 共享该绑定时，也共享其沙箱设置。Agent Bundle 内的被评测 Agent、Evaluator、Application 生命周期操作和远程服务，沿用各自的执行环境。

## 选择档位

| 取值              | 已启用的模型工具及其受约束子进程的文件写入范围         | 适用场景                                             |
| ----------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| `inherit`         | 使用后端现有调用行为和生效的原生设置。                 | 保留已有原生配置，包括显式档位排除的能力。           |
| `read-only`       | 禁止写入普通文件，包括工作区文件和临时文件。           | 读取输入、返回结构化提案，不运行需要可写文件的工具。 |
| `workspace-write` | 允许写入本次调用的工作目录，以及原生沙箱开放的临时区。 | 运行需要创建工作文件或临时输出的工具。               |

文本检查和结构化提案可以先选择 `read-only`；已启用的工具需要创建文件时，选择 `workspace-write`。`inherit` 保留原生行为，原生配置本身可能已经启用沙箱；它不代表统一的 RSI 隔离级别。

工作区是调用方为单次 Agent 调用传入的工作目录，通常包含准备好的任务输入副本。Recipe 所在目录和其他宿主机目录不会自动成为额外可写目录。

候选修改仍通过结构化提案和 Application 校验流程提交。`read-only` Agent 可以提出修改，由 RSI 在该 Agent 调用之外应用。

## 配置 Recipe 或 Policy

以下示例均为片段，需要合并到已有 Recipe 或 Policy 中。`agent` 是示例绑定名，请使用 Policy 声明并由调用组件引用的实际 Agent 绑定名。

### 在 Recipe 中设置档位

```yaml
# Recipe fragment
bindings:
  agent:
    plugin: agent.codex
    config:
      sandbox: read-only
```

将 `agent.codex` 换成 `agent.claudecode` 或 `agent.dsh`，即可选择其他支持的后端。CLI 不使用默认命令名时，设置 `config.executable`。

### 设置 Policy 默认值

```yaml
# Policy fragment
defaults:
  bindings:
    agent:
      plugin: agent.codex
      config:
        sandbox: workspace-write
```

使用同一插件时，Recipe 的绑定配置会逐字段覆盖 Policy 默认值。Recipe 省略 `sandbox` 会保留 Policy 的取值。合并后的配置也没有 `sandbox` 时，后端采用 `inherit` 行为。

需要显式覆盖 Policy 的沙箱默认值时：

```yaml
# Recipe fragment
bindings:
  agent:
    config:
      sandbox: inherit
```

更换绑定的 `plugin` 会丢弃原插件的默认配置。切换插件时，请为新后端显式设置需要的 `sandbox`。绑定声明与默认值的完整规则见[编写 Policy](writing-policies_zh.md)。

## 理解隔离边界

| 范围                | 显式档位的行为                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 工具文件写入        | 所选档位约束已启用工具及其受约束子进程直接发起的写入，排除宿主配置中的额外可写目录。                                            |
| 文件读取            | 沿用已启用工具和原生后端的读取规则。这些档位没有定义统一的读取隔离策略。                                                        |
| 网络访问            | 沿用原生网络规则，`config.sandbox` 没有单独的网络访问选项。                                                                     |
| 网络或 IPC 服务     | 通过网络或套接字调用的服务，按服务自身权限执行写入。                                                                            |
| RSI 与可信 CLI 状态 | RSI 产物、调用准备及可信 CLI 自身的会话记录，仍由各自负责。`read-only` 描述模型工具的写入权限，不代表整个实验期间没有任何写入。 |
| 宿主机配置          | 通过本次调用的参数、设置或独立配置目录传入约束，启用档位时不改写宿主机的用户级或系统级配置。                                    |

无法纳入写入边界的宿主可执行扩展会被排除。目前三个后端的显式档位均关闭子 Agent 工具。放入本次调用工作区的 Skill 文件仍可读取。

## 后端差异

### Codex

RSI 使用 Codex 原生沙箱策略和进程级配置覆盖。显式档位关闭继承的 MCP 服务、hooks、通知命令和可执行扩展功能。原生 patch 和 Shell 工具在所选边界内执行。

Codex 使用非交互式审批。被拒绝的操作会返回工具错误，不会弹出审批请求。模型访问继续使用原生模型和认证设置。

### Claude Code

已启用的文件系统和 Shell 工具随档位变化：

| 档位              | 已启用工具                                                                     |
| ----------------- | ------------------------------------------------------------------------------ |
| `read-only`       | Glob、Grep。Bash、Read、Edit、Write 不可用。                                   |
| `workspace-write` | Read、Glob、Grep 和沙箱内的 Bash。Edit、Write 不可用，文件写入通过 Bash 完成。 |

原生 Read 工具可能在渲染 PDF 时创建临时文件，因此只读档位会关闭它。需要执行 Shell 或读取 PDF 的工具调用，应选择兼容的工作流和档位。

RSI 使用独立的 Claude 配置目录，关闭继承的 hooks、MCP 服务、插件以及 `apiKeyHelper` 等可执行认证辅助项，并向本次调用传入支持的模型服务环境设置和原生 OAuth 凭据。原有认证依赖可执行辅助项时，请改用环境凭据或原生 OAuth。

### DSH

RSI 使用独立的原生配置目录和安装包自带的 base/headless 组件，向本次调用传入模型/provider 的字面量设置、环境配置及原生凭据。自定义可执行 profile 组件会被排除，包含可执行表达式的模型/provider 配置会被拒绝。

文件系统和 Shell 服务执行所选策略。模型工具开放 Bash、读取/搜索工具及 Skill；独立的 Edit、Write 工具会被排除，允许的写入通过 Bash 完成。RSI 在提交任务前要求原生沙箱完整执行约束。

## 运行与排查

将设置加入完整的 Recipe 后运行：

```sh
arsi doctor path/to/recipe.yaml
arsi run path/to/recipe.yaml
```

在源码仓库中使用时，先构建，再将 `arsi` 换成 `pnpm arsi`。Doctor 可以发现沙箱启动问题；模型访问仍需要可用的原生 CLI 配置。报告含义见 [Doctor](doctor_zh.md)。

| 现象                               | 处理方式                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 沙箱准备失败                       | 检查 Linux 支持、CLI 兼容性及原生沙箱依赖。Claude Code 需要能从 CLI 环境找到 `bubblewrap` 和 `socat`。               |
| 普通调用认证正常，显式档位认证失败 | 检查是否依赖已排除的可执行扩展。Claude Code 使用支持的环境凭据或原生 OAuth；DSH 使用原生模型/provider 的字面量设置。 |
| 工具不可用                         | 查看上述后端工具列表和排除项。Claude Code 只读调用中没有 Bash 或 Read 工具。                                         |
| 写入被拒绝                         | 检查档位和目标路径。`read-only` 禁止普通文件写入；`workspace-write` 仅允许本次工作区及原生临时区。                   |

需要在源码仓库中验证已安装 CLI 的隔离边界时，单独运行原生集成入口：

```sh
pnpm test:integration:agent-sandbox
```

运行需要 Linux、已安装的项目依赖、三个原生 CLI 及其沙箱依赖。检查通过受控文件和本地确定性 API fixture，验证原生文件与 Shell 操作的实际效果，不运行基准任务或外部模型请求。它们独立于默认单测。
