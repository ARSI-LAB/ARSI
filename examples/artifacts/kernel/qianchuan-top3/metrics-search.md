# top3 指标驱动优化实验

本流程使用真实 Agent、CPU embedding 和 Evaluator SDK；算子修改范围为 baseline 的 `input.py`，任务仍为 `fixed`、seed 42。稳定性校准可选，用于结果可信度，不作为生成准入。诊断预检、两轮联调、完整搜索使用不同实验 ID，原始结果均保留。

## 环境与准备

在 NPU 环境部署 RSI；使用 `pnpm install --frozen-lockfile` 安装锁定提交的 Evaluator 与 AgentBundle SDK，无需相邻源码仓库。使用 Node 24.22.1、pnpm 11.22.0；SDK Python 和 CPU embedding Python 分开准备。目标环境为 950PR / CANN 9.1.0 / openEuler。检查容器 CPU/内存配额、设备独占、空间、实例剩余时间和数据保留条件。

以下变量由部署环境提供，不把 API 密钥写入 Recipe、命令行参数或部署包：

```sh
export SDK_PYTHON=/workspace/ascendagent-m2-venv/bin/python
export EMBEDDING_PYTHON=/workspace/ascendagent-embedding-venv/bin/python
export EMBEDDING_MODEL_DIRECTORY=/workspace/ascendagent-models/qwen3-embedding-0.6b
export EMBEDDING_IDENTITY_FILE=/workspace/ascendagent-models/qwen3-embedding-identity.json
export MSPROF_BIN=/path/to/isolated/msprof-fixed
export MSTX_PYTHON_DIRECTORY=/path/to/isolated/mstx/lib64
export PYTHONPATH="$MSTX_PYTHON_DIRECTORY${PYTHONPATH:+:$PYTHONPATH}"
# MODEL_NAME、MODEL_ENDPOINT、MODEL_API_KEY 从私有环境配置加载。
```

当前环境的设备映射修复采用 [msopcom 官方补丁 cf6a180](https://github.com/Ascend/msopcom/commit/cf6a1801f189c55340fe01de67c8dc496bd8d006)，在完整工具副本内替换本地重建的注入库，保留系统 CANN 安装。原工具与插件使用 ABI0，重建时需匹配 `_GLIBCXX_USE_CXX11_ABI=0`；这不是对其他环境的通用假设。上面的 `MSPROF_BIN` 应指向已核验库路径、SHA-256 和实际加载记录的隔离 launcher。调用入口必须显式传入 `--msprof-bin "$MSPROF_BIN"`；程序不自动选择修复工具，也不在失败后切换采集协议。未提供该参数时保留 Recipe 已有的 `sdk.profiling.msprofBin`。

独立诊断需要与 SDK Python 兼容的官方 `mstx` 模块；先用 `"$SDK_PYTHON" -c 'import mstx; print(mstx.__file__)'` 核对实际加载路径。部分镜像的公共 Python 软链可能失效，应将已验证的实际模块目录加入 `PYTHONPATH`。采集子进程会验证 msprof 注入工具 ID 为 `4097`；范围 ID `0` 是合法值。25 次候选预热和同步在 `rsi_operator_profile` 范围之外，随后一次正式 Python 候选调用和同步在范围内。msprof 内部重放次数独立，不能把 `callsInRange=1` 当作一次 NPU 执行。

进入 RSI 仓库后执行 `pnpm check && pnpm check:package`。该检查包括类型、测试、构建和独立安装包消费，不会请求模型或使用 NPU。部署后还需执行真实设备预检，不能以本地测试替代。

编辑 [hardware-context.md](hardware-context.md)，核对/增补用户掌握的硬件信息。初始值来自 ngo-agent 模板，标明非实测；不清楚的内容可以删除。Recipe 会显式引用并冻结全文，每次生成和修复都会使用它，恢复不重新读取原文件。没有该文件需求时从 Recipe 删除 `hardwareContextFile` 配置；配置文件不存在或为空会提前失败。

## 1. 环境与独立诊断预检

```sh
node scripts/check-operator-npu.mjs \
  --id top3-metrics-host-001 --python "$SDK_PYTHON" --device 0

node scripts/run-operator-sdk.mjs \
  --id top3-metrics-profile-001 \
  --recipe examples/artifacts/kernel/qianchuan-top3/recipe.profile.yaml \
  --python "$SDK_PYTHON" --device 0 --msprof-bin "$MSPROF_BIN"
```

第二条命令执行一次精度/性能评测，随后独立诊断，不调用优化 Agent，不额外执行最终复测。`collectionStatus=completed` 才说明采集完成；仍需检查指标有效性、kernel 覆盖、seed、单位和原始 CSV。明确不可用时退出码为 1，先定位原因再继续。

这两个示例 Recipe 显式使用 `sdk.profiling.collection: Default`，详细诊断 warmup 为 25，输入来自同一冻结任务的 seed 42，关闭跨运行磁盘缓存。`Default` 采集管道利用率、L2 和资源冲突等 CSV，不要求 PipeTimeline trace；trace 分析应明确标为未采集，其 duration 不用于性能晋级。Evaluator SDK 未显式配置 collection 时仍默认 `PipeTimeline,Default`。

原完整 `PipeTimeline,Default` 协议在当前 950PR / CANN 9.1 环境未通过：映射修复后仍在 driver 停止采集通道时超时。保留该失败的原始证据；本流程经明确选择继续验证 `Default`，不能将其结果表述为完整协议或 timeline 已通过，也不能把配置/本地测试当作真机验收。

## 2. 不执行设备或模型的配置检查

```sh
node scripts/run-operator-search.mjs --validate \
  --python "$SDK_PYTHON" --device 0 --msprof-bin "$MSPROF_BIN" \
  --embedding-python "$EMBEDDING_PYTHON" \
  --model-directory "$EMBEDDING_MODEL_DIRECTORY" \
  --embedding-identity "$EMBEDDING_IDENTITY_FILE" \
  --max-rounds 2
```

验证结果仅证明配置、资源和本地 embedding 身份可以读取，不证明真实模型、精度或诊断可用。

## 3. 两轮真实联调

```sh
node scripts/run-operator-search.mjs \
  --id top3-metrics-two-rounds-001 --max-rounds 2 \
  --python "$SDK_PYTHON" --device 0 --msprof-bin "$MSPROF_BIN" \
  --embedding-python "$EMBEDDING_PYTHON" \
  --model-directory "$EMBEDDING_MODEL_DIRECTORY" \
  --embedding-identity "$EMBEDDING_IDENTITY_FILE"
```

默认 Recipe 先执行一次静态阶段，再进入指标循环。检查至少两个实际指标生成/评测轮次，第二轮请求确实收到第一轮历史；核验分析引用的指标、检索结果、硬件原文和候选父链。无合法候选或指标提前不可用不能宣称通过两轮联调。

## 4. 完整搜索与恢复

两轮验收后使用新 ID，省略 `--max-rounds` 即使用 Recipe 默认最多 10 轮。连续 5 个正确但未晋级的候选、预算不足或诊断不可用都可能提前结束；正确性错误每个候选最多修复 3 次。晋级只依据耗时严格超过 2% 门槛，诊断用于改进方向。

```sh
node scripts/run-operator-search.mjs \
  --id top3-metrics-full-001 \
  --python "$SDK_PYTHON" --device 0 --msprof-bin "$MSPROF_BIN" \
  --embedding-python "$EMBEDDING_PYTHON" \
  --model-directory "$EMBEDDING_MODEL_DIRECTORY" \
  --embedding-identity "$EMBEDDING_IDENTITY_FILE"
```

恢复使用同一命令、同一 ID 和参数并加 `--resume`，包括同一显式 `--msprof-bin` 路径。该覆盖值同时冻结到 Recipe 和 executionParameters；更换路径会拒绝恢复，应使用新实验 ID。两轮实验恢复还需同样的 `--max-rounds 2`。完成实验恢复不新增模型或设备调用；运行中或未知结果的调用不会盲目重试，先核实进程与清理。修改输入/参数或换环境应启动新实验。

输入快照与摘要分别位于 `.rsi/operator-search/<id>/` 或诊断的 `.rsi/operator-sdk/<id>/`，Manager 事实与制品保存在运行根目录的 `.rsi/` 中。导出时包含其引用的事实与制品，不能只复制 summary 或 best-input.py；记录三仓构建、Manifest 与 SHA-256，扫描排除私有凭据。

## 结果解释

报告分别陈述闭环是否完成、正确性、观测晋级和可信度。`improvementStatus=verified` 才表示现有校准/复测证据支持可靠收益；没有加速仍可通过框架闭环验收。未在真机触发的修复、晋级后采集或复用路径明确列为未覆盖。

SDK 调用按 evaluate/profile 分别报告；内部采集重试另计，未知 NPU 执行次数不填零。单个完整搜索最多 54 次精度/性能评测和 11 次独立诊断；先前预检、两轮联调及校准另行计账。原始证据不足、清理未知或设备故障时停止设备调用，报告未完成原因。
