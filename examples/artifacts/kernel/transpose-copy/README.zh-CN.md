# Transpose-copy 算子优化

> [English](./README.md) | 中文

本例使用 `policy.operator-search` 评测已封存的 Triton-Ascend 基线，生成并修复候选，
选择改进结果，再独立复测选中的源码。可选的硬件诊断用于驱动后续搜索轮次。
`application.kernel` 管理源码工作区，`proposer.operator` 提出修改，
`evaluator.operatorbench` 调用完整 Evaluator SDK。

任务接收形状为 `[381, 51200]` 的 FP16 张量，返回形状为 `[381, 80, 80, 8]`、
内存连续且独立存储的 FP16 张量，并保持输入不变。计算过程先调整形状，再交换两个
空间轴，最后将转置视图复制为连续内存。
固定用例使用种子 42，数值容差为零。入口为 `kernel_function`，
冻结参考与契约见 [task](./task/task.json)。

## 配置与运行

使用装有 CANN、torch、torch_npu、triton-ascend，以及锁定版本 Evaluator SDK
所需 profiling 依赖的 Linux NPU 主机。在私有环境配置中设置 `MODEL_NAME`、
`MODEL_ENDPOINT` 和 `MODEL_API_KEY`。

运行 [Recipe](./recipe.search.yaml) 前，替换其中 SDK Python 路径、embedding Python
路径、模型目录、身份文件、外部知识包和外部检索脚本的占位值。
[hardware-context.md](./hardware-context.md) 中的硬件描述应与所选设备一致。

Policy 包为六个阶段提供通用提示词，并通过默认 Proposer 绑定配置 `promptsDirectory`。
本 Recipe 使用 `bindings.proposer.config.promptsDirectory: ./prompts` 显式选择本地
[prompts 目录](./prompts)，采用本例的六份 Triton-Ascend 模板。
相对路径以 Recipe 所在目录为基准解析。

自定义提示词目录必须包含完整的六个文件：`diagnose.md`、`diagnose-metrics.md`、
`generate.md`、`generate-metrics.md`、`repair.md` 和 `summarize.md`。
独立使用 `proposer.operator` 时也必须配置完整目录。复制或部署本例时，
将 `prompts/` 与 Recipe 一同保留。已安装的 RSI 包提供自己的默认提示词，
不依赖仓库中的 `examples/` 目录。

后端支持范围与联网能力由配置的 Application、Evaluator 和 Agent 决定。
只有所选 Agent 实际提供已授权的联网工具时，才适用提示词中的联网查询建议。
提示词内容参与分析身份校验；续跑冻结实验时，须保留所选目录及其内容。

知识包和检索实现单独部署。`embedding.resourcesDirectory` 指向知识包根目录，
其中包含 `knowledge/manifest.json` 及其声明的资源。
`embedding.retrievalScript` 指向由 `embedding.python` 执行的 worker。
Manifest 记录资源的 SHA-256 摘要。模型文件、资源、提示词和 worker 均参与身份校验。
缺少文件、摘要不匹配，或返回结果的身份与请求不一致时，插件会拒绝该输入或结果。

Manifest 使用 `schemaVersion: rsi.operator-knowledge/v1`；`resources` 条目包含
相对 `path` 和 `sha256`；`techniques` 与 `metrics` 数组的条目引用 `id`、
`document` 和 `example`。可选的 `guidelines` 指定清单内的一份文本资源。
将所选知识提供方的知识包和 worker 作为有明确版本的输入部署。

Worker 命令为 `<embedding.python> <embedding.retrievalScript> --request
<json-path> --response <json-path>`。请求使用 `rsi.operator-retrieval-request/v1`，
包含模型与资源的位置和摘要、CPU 编码选项、相似度阈值，以及静态 `issues`，
或带有 `mode: metrics` 的指标 `query`。响应使用 `rsi.operator-retrieval/v1`，
回传模型与资源身份，并提供 `matches`、`knowledgeContext`、`omitted`
和运行时版本信息。匹配结果引用清单内的技术条目及其文档、示例摘要。
插件校验该边界，并记录 worker 自身的摘要。

Embedding 身份文件使用 `rsi.operator-embedding-identity/v1`，包含带 `id`
和不可变 `revision` 的 `model` 对象；`encoding` 对象包含
`queryPromptName: query`、`normalizeEmbeddings: true`、`device: cpu` 和
`batchSize: 32`；`files` 清单记录相对路径与 SHA-256 摘要。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm ember-rsi validate examples/artifacts/kernel/transpose-copy/recipe.search.yaml
pnpm ember-rsi run examples/artifacts/kernel/transpose-copy/recipe.search.yaml --id transpose-copy-search-001
pnpm ember-rsi show transpose-copy-search-001
```

续跑时使用相同 Recipe 和 ID 再次执行 `run`，并添加 `--resume`。
输入、构建和外部资源必须保持一致。已完成实验的续跑会复用已记录结果。
运行数据存放于 `.rsi/`。

Recipe 只选择正确且平均延迟降低超过 2% 的候选。`finalValidity` 记录独立最终评测，
`finalTimingStable` 检查选中结果与复测结果的延迟差是否不超过二者均值的 5%。
这些结论只适用于所记录的协议；可靠加速需要在真实设备上重复测量。
Manager 执行 Recipe 的操作数、模型调用数、评测次数和时间预算限制。
预算耗尽后，通过标准失败与恢复路径停止执行。

## 搜索模式与限制

两种模式均由一个 `policy.operator-search` 编排。
将 `policy.config.metricsEnabled` 设为 `false` 时仅执行静态搜索；
保留本例的 `true` 时，在静态搜索后继续分析实测瓶颈。

静态搜索先评测基线，再诊断冻结源码并检索外部指导。
每次新尝试从阶段入口候选开始，修复则从失败候选开始。
正确但更慢的候选会被总结，但不会替换当前最佳候选。
接受一次改进后结束静态搜索；静态诊断为空时跳过候选生成。
两种情况都可以继续进入可选的指标阶段。

指标阶段采集当前最佳候选的 profile，分析实测瓶颈、检索指导，
并基于该候选生成新实现。每次接受改进后，在下一轮之前重新采集 profile；
没有接受改进时，复用未改变候选的诊断证据。
Profiling 不可用时停止指标阶段。两种模式都在结束时独立复测选中的源码。

| Recipe 设置                                                    | 示例值     | 含义                                                      |
| -------------------------------------------------------------- | ---------- | --------------------------------------------------------- |
| `policy.config.maxAttempts`                                    | `3`        | 静态尝试次数上限，取正整数。                              |
| `policy.config.repairLimit`                                    | `3`        | 每条无效候选链的修复次数上限，取非负整数。                |
| `policy.config.maxRounds`                                      | `10`       | 指标阶段轮数上限，取正整数。                              |
| `policy.config.maxNoImprovement`                               | `5`        | 上次接受改进后，未被接受的有效候选数上限，取正整数。      |
| `bindings.proposer.config.historyWindow`                       | `5`        | 提供给生成阶段的最近总结数量，默认 5。                    |
| `bindings.proposer.config.modelRequestTimeoutMs`               | `120000`   | 一个完整模型阶段的时间上限，单位 ms；`0` 关闭此本地期限。 |
| `bindings.proposer.config.embedding.timeoutMs`                 | `300000`   | 检索 worker 的时间上限，单位 ms；`0` 关闭此期限。         |
| `bindings.proposer.config.embedding.maxPayloadBytes`           | 省略       | 可选的单份外部检索 JSON 数据字节上限。                    |
| `bindings.proposer.config.embedding.maxLogBytes`               | 省略       | 可选的检索 worker 单个输出流的字节上限。                  |
| `bindings.proposer.config.embedding.similarityThreshold`       | `0.6`      | 检索匹配分数下限。                                        |
| `bindings.evaluator.config.benchmark.config.warmup` / `repeat` | `5` / `20` | 评测预热次数与计时重复次数。                              |
| `bindings.selector.config.minRelativeImprovement`              | `0.02`     | 合格候选平均延迟所需的相对降低比例。                      |

本例 Manager 上限为 1,024 次操作、65 次评测、152 次模型调用、
7,200,000 ms 总时长，以及 60,000 ms 清理预留时间。
评测次数同时包含 `evaluate` 和 `profile`；模型调用同时包含工具后续调用与委派。
单个 Agent 请求和执行范围还可以配置更低上限。提高总预算不会绕过这些限制，
也不保证所有配置的轮次都能执行。Proposer 的两个超时字段接受
`0` 到 `2147483647` 的整数毫秒数，并保留上表中的默认值。
省略检索字节上限时，不限制对应维度。
Application 的 [Target](./target.yaml) 控制源码大小与修改字节数上限；
本例将两者显式设为 32,768 字节。授权更大源码时，提高或省略这些 Target 限制。

## Ascend 性能采集配置

SDK 与 CPU embedding 使用独立的 Python 环境，避免安装 embedding 依赖时
替换选定的 torch_npu/CANN 环境。外部检索 worker 的依赖与模型权重单独部署；
RSI 包不会在搜索过程中安装知识提供方或下载权重。

Recipe 选择 `benchmark.config.profiling.collection: Default`，预热 25 次，最多采集两次，
每次上限 300 秒。`benchmark.config.profiling.enabled: false` 关闭普通评测中的自动诊断；
Policy 的显式 `profile` 操作仍会启用采集，并强制关闭磁盘缓存。

详细采集要求所选 SDK Python 环境中具有可用的 `msprof` 和兼容的 `mstx` 模块。
先加载匹配的 CANN 环境；使用独立安装的 profiler 时，显式配置
`bindings.evaluator.config.benchmark.config.profiling.msprofBin`。
解释器、设备、采集模式及实际工具版本均须随运行证据保留。
可编辑的 hardware-context 模板不能代替实际观测的设备事实。

`Default` 采集 PipeUtilization、L2Cache 和 ResourceConflictRatio 三类 CSV 表，
将时间线证据标为不可用，不能据此得出 PipeTimeline、流水重叠、气泡或 Double Buffer 结论。
需要可用 trace 证据时，显式选择 `PipeTimeline,Default`。
采集、清理、指标单位和证据校验由 SDK 负责；见锁定版本的
[NPU kernel 指南](https://github.com/evolving-foundry/ember-evaluator/blob/99392461cfdac9edb4ad2b49fa7c52a954125f1b/docs/users/benchmarks/kernel-npu.zh-CN.md)。

## 结果与验证

检查 Policy 输出中的 `bestCandidateRef`、`bestMeasurementRef`、
`finalMeasurementRef`、`finalValidity`、`finalTimingStable` 和 `stopReason`。
`attempts`、`metricsRounds`、`diagnosticRefs` 及历史引用保留搜索决策与证据。
没有候选优于基线时，已完成实验可以保留基线。

`candidateValid` 表示正确性，`latencyMeanMs` 是候选的平均设备延迟，
`speedupVsReference` 比较候选与数学 PyTorch 参考。
要证明优化了原始 kernel，须在相同任务、协议和环境下比较原始与选中 kernel；
仅凭相对 PyTorch 的比值不能证明这一收益。

离线软件检查使用 `pnpm check` 和 `pnpm check:package`。
这些检查使用受控 worker，不能证明真实 NPU 上的正确性或性能。
`validate` 检查配置；真实运行还须验证设备就绪、严格正确性、计时证据和资源清理。
导出实验时，保留 `.rsi/` 中的 Manager 事实及引用的不可变产物，
包括 SDK run ID 和原始证据。仅保留摘要或选中的源码不足以恢复或审计。
凭证不得放入共享示例或导出的记录。

## 任务来源

任务副本来自相对仓库根目录的 `../../kernel-tasks/qianchuan_top3_kernel`。
运行时读取示例中包含的任务副本。除将 CRLF 统一为 LF 外未做其他修改，
已有声明均予保留。

| 原始文件     | 原始字节 SHA-256                                                   | 随附 LF UTF-8 文件 SHA-256                                         |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `input.py`   | `de4a94cc5092f5260b414609af0f34e4c12b5db4e1bedc0b78d18de2913c6d81` | `cfbd24fab79b29be38e9c4ebdd4298be60310ad5c9db31bfdcf3f245fd973bd8` |
| `problem.py` | `1ae6e43d88d15ca0a6211662d2978dc59b8b1cc04c81f32df25b7140c64aecd8` | `8e4afaa3a4dde97a95f65dec490402cd2f93103af9c0201800f53883414f8f6a` |
| `test.py`    | `045f9d743e59fd97624885eec3fa894b9496820c3f8494208d594eb01f943dfe` | `407feea703eb23bc7eff8757edff5928841c1e76d29e205fd81f13ecea21a796` |

随附 `test.py` 记录原始行为。实际正确性与计时以 SDK 的冻结参考和严格检查器为准。
