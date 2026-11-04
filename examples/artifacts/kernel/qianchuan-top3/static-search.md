> 完整指标优化入口请参阅 [指标驱动实验](metrics-search.md)。当前默认 `recipe.search.yaml` 已启用指标阶段；如需仅静态实验，使用独立 Recipe 显式配置 `metricsEnabled: false`，并将预算限制为静态范围。

# Triton-Ascend 静态搜索实验

本入口使用 `agent.pi`、`proposer.operator`、真实 Evaluator SDK 和 `selector.metric`。Proposer 内部完成静态诊断、CPU embedding 检索、生成、修复和总结；不另设 Analyzer 或 Memory 插件。通用 `memory.agent` 仍服务其他业务，算子 Recipe 不绑定它。

## 流程与预算

1. 评测入口 baseline 并验证其有效性和比较身份。
2. 单独调用模型诊断源码；只支持知识库中的四类问题。诊断为空时直接复测 baseline，不虚构优化尝试。
3. 对有效诊断执行一次本地检索：查询为 `issue_type: issue_summary`，查询 prompt 为 `query`，向量归一化后按余弦相似度筛选；阈值 0.6，上下文最多 20,000 字符，完整示例最多 3 个。正常未命中仍可按诊断生成；执行失败会停止实验。
4. 每次新尝试从入口源码生成，最多 3 次。每个候选先 SDK 评测；明确的候选错误最多连续修复 3 次。有效但无收益的候选进入总结，下一次尝试重新使用入口源码和已验证历史。
5. 每个实际尝试单独总结。事实、指标、决策和候选链由程序核验，模型只写解释与建议。总结完成后才晋升候选，首次达到配置收益阈值即停止搜索（示例默认 2%，与 ngo-agent 的静态阶段一致）。
6. 对胜出源码独立复测。`finalValidity` 表示最后一次正确性，`finalTimingStable` 要求与该源码之前的测量差异不超过两次均值的 5%；不稳定不能作为可靠性能收益。

SDK 最多 14 次（baseline 1 + 3×4 + 最后复测 1）。模型业务请求最多 16 个，每个请求及全部子 Agent 共用最多 2 次模型调用，实验最多 32 次。总操作预算 256，总时限 40 分钟，预留清理 60 秒。无自动网络重试。算子模型阶段直接使用请求内授权快照，并通过 Agent 的 `allowTools:false` 禁用文件读取和委派工具，避免消耗结构化输出纠错预算；通用 Agent 缺省仍启用工具。基础设施失败、未知清理和未完成回执均不能当作候选缺陷继续修复。

## 部署两个 Python 环境

Evaluator 使用已在 950PR 上验收的 SDK Python；embedding 使用独立的 CPU Python，避免替换 `torch_npu` 环境。模型文件由部署者预先准备，运行时禁止自动下载。

```bash
python3.12 -m venv /opt/operator-embedding-env
/opt/operator-embedding-env/bin/python -m pip install \
  -r src/plugins/proposer-operator/python/requirements.txt
```

本机已验证官方 `Qwen/Qwen3-Embedding-0.6B` 的固定 revision `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3`。本机真实编码使用 Python 3.12.13、torch 2.7.1+cpu、sentence-transformers 5.1.2 和 transformers 4.57.3：四类技巧均命中、无关问题未命中；一次检索耗时 7.53 秒，峰值 RSS 约 3.71 GiB。此资源数值仅代表本机该次运行。目标环境仍需重新验证，保留模型来源、文件 SHA-256、实际依赖版本和资源用量。模型权重不放入 Git 或普通源码包。

在准备好完整权重后生成不可变清单，输出文件不得已存在：

```bash
node scripts/prepare-operator-model.mjs \
  --model-directory /opt/models/qwen3-embedding-0.6b \
  --model-id Qwen/Qwen3-Embedding-0.6B \
  --revision 97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3 \
  --out /opt/models/qwen3-embedding-0.6b.identity.json
```

清单核验实际文件及字节，不能独立证明模型支持 `query`。CPU worker 的请求、响应、版本和进程退出证据保存在调用目录；输入身份、诊断和历史保存在不可变制品中。

## 静态预检和正式搜索

先安装并验证锁定依赖：`pnpm check && pnpm check:package`。通过私有环境注入 `MODEL_NAME`、`MODEL_ENDPOINT`、`MODEL_API_KEY`；Recipe 仅保存变量引用，不写密钥。`MODEL_ENDPOINT` 应为兼容 OpenAI Chat Completions 的 API 根路径（通常以 `/v1` 结尾）。

以下只检查配置和本地模型文件，不执行模型或设备调用，也不给出性能准入：

```bash
node scripts/run-operator-search.mjs \
  --id top3-search-static-001 --validate \
  --python /opt/operator-env/bin/python --device 0 \
  --embedding-python /opt/operator-embedding-env/bin/python \
  --model-directory /opt/models/qwen3-embedding-0.6b \
  --embedding-identity /opt/models/qwen3-embedding-0.6b.identity.json
```

正式搜索不要求校准先通过：本次 baseline 正确且 SDK 证据有效，即可诊断、生成、评测、修复和总结。`--calibration` 可选；不提供时仍可运行。提供时重新审计匹配版本的 Manager 事实及原始 CSV/trace，`failed-noise` 只降低结果可信度。旧构建、环境或任务不匹配的校准标记 `not-applicable`，不用于性能背书。校准证据损坏、当前基础设施失败和清理未知仍停止，不能当作候选缺陷修复。

Selector 的搜索门槛由 Recipe 决定（默认 2%），可用 `--min-relative-improvement` 显式覆盖；不再从 M2 的 N/T 强制注入。达到门槛表示观测到收益，不自动表示可靠收益。

```bash
node scripts/run-operator-search.mjs \
  --id top3-search-001 \
  --python /opt/operator-env/bin/python --device 0 \
  --embedding-python /opt/operator-embedding-env/bin/python \
  --model-directory /opt/models/qwen3-embedding-0.6b \
  --embedding-identity /opt/models/qwen3-embedding-0.6b.identity.json
```

`performanceQualified` 只表示测量条件具备校准与复测支持，不表示产生收益；可靠收益必须看 `improvementStatus: verified`。

需要附带已有校准时增加 `--calibration <campaign-id>`。报告分别保留 `calibration`、`finalTimingStable`、`performanceQualified` 和 `improvementStatus`：

- `pending`：观测到收益，但校准缺失、不适用、噪声超标，或独立复测没有支持可靠收益。
- `verified`：当前比较身份匹配的校准通过，最终同源码计时稳定，且独立复测仍达到搜索门槛和校准噪声门槛。
- `not-observed`：没有选中达到搜索门槛的新候选。
- `invalid`：最终正确性或比较证据无效；保留候选和原始数据，不宣称可靠收益。

最终计时波动不再使已完成的搜索返回失败或删除候选；最终正确性失败、基础设施故障和清理异常仍明确报告失败。首次及后续新尝试始终从入口源码生成，修复才基于失败候选，沿用 ngo-agent 的静态阶段组织。

入口与预检、校准共用设备会话锁。输出保存在 `.rsi/operator-search/<id>/`，冻结 Recipe、任务、Policy、Prompt、知识资源、构建及模型 identity；权重保留在显式部署目录，每次核验文件字节。不得在运行中修改或移动权重。完整归档须包含 Manager 事实和全部不可变制品，单独报告不能恢复实验。

使用相同参数加 `--resume` 只复用已确认成功的回执。完成实验恢复不得增加调用。失败、运行中或结果未知的 action 不自动重放；先保留证据并核实外部效果，不能删除锁、换 ID 或补造总结来绕过。

## 本地功能验证与真实验收的区别

真实模型的 CPU 联调需先获得项目源码向所选模型服务发送的授权。私有 JSON 只在本机提供 `model`、`base_url`、`api_key`，不要提交或打包；下例只在授权后显式执行：

```bash
node scripts/integration-operator-search.mjs \
  --id top3-functional-001 --model-config /secure/operator-model.json \
  --embedding-python /opt/operator-embedding-env/bin/python \
  --model-directory /opt/models/qwen3-embedding-0.6b \
  --embedding-identity /opt/models/qwen3-embedding-0.6b.identity.json
```

默认 `pnpm test` 使用模型和设备的确定性测试替身，验证编排、反馈、预算、身份和恢复边界。显式 CPU 集成可以调用真实模型与 embedding，但设备 worker 仍是测试替身；结果必须标注 `performanceQualified:false`。这些验证均不证明 950PR 编译、正确性、真实计时或性能收益。

真实验收需保留：本次三仓源码与构建身份、可选的 M2 报告及其适用性、模型/embedding 固定版本、实际调用与清理证据、候选源码差异、全部 SDK runId/正确性结果/原始计时证据、Selector 决策、最后复测与完成恢复用量。未达阈值的有效候选也是完整实验结果，不将无收益改写为优化成功。
