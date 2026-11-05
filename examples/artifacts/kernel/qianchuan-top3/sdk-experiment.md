# top3 完整 SDK 实验说明

此入口使用真实 `Evaluator.run()`、kernel Benchmark 和 KernelReplay。通过独立 `policy.operator-baseline` 评测 baseline 后独立复测，仅绑定 Evaluator 与 Selector，无需模型凭据、Agent、Proposer 或 embedding。实现与验收记录见[中文 M1 任务记录](https://github.com/chestnut19981123/ember-rsi/blob/a3f0c18baf62db017f356ec59c6ec02f20689ba7/docs/tasks/2026-10-31/2026-10-31-feature-operator-sdk-m1.md)。

## 本地验证与真实设备边界

无 NPU 联合测试使用测试专用设备 worker，实际经过 SDK 来源锁、执行、采集、清理，以及 RSI 的 Application、Manager、Measurement、Selector 和 Policy。搜索测试另外验证 Proposer 收到诊断并经历失败修复、退化拒绝、改善接受与 no-change。

设备 worker 的耗时和环境标识是 fixture。它们不证明真实算子精度、真实性能、硬件稳定性或代码优化收益。M2 已增加环境预检、关联证据计时审计、批量校准和离线报告；此前真实 950PR 实验已完成基础闭环与恢复验证，但性能稳定性未通过；本次 SDK-only 构建尚未重新进行设备验收。实施和实际验证见 [M2 任务记录](https://github.com/chestnut19981123/ember-rsi/blob/a3f0c18baf62db017f356ec59c6ec02f20689ba7/docs/tasks/2026-10-31/2026-10-31-feature-operator-npu-m2.md)。

## 在 NPU 主机运行

1. 安装 RSI 及锁定提交的 Evaluator SDK；SDK 自己管理 AgentBundle、依赖安装和构建，无需相邻源码仓库。使用 Node `>=24.22.1 <25` 和 pnpm `11.22.0`。
2. 准备已安装 PyTorch、torch_npu、Triton-Ascend、CANN 和驱动的 Python 环境。解释器和设备由命令显式指定。需要 profiling 时还需 msprof。
3. 从 RSI 仓库根目录安装依赖并构建，然后运行：

```bash
pnpm install --frozen-lockfile
pnpm build
node scripts/run-operator-sdk.mjs \
  --id top3-sdk-baseline-001 \
  --python /opt/operator-env/bin/python \
  --device 0
```

解释器路径是示例，需替换为实际路径。`--device` 选择物理可见卡；Evaluator 设置可见集合后，worker 在其中使用逻辑卡 0，并记录实际观察信息。请先确认该设备没有其他实验干扰。

首次运行固定 case 为 `fixed`、seed 42，容差均为零，预热 5 次、有效重复 20 次。比较整个 PyTorch 参考输出，要求 FP16、指定 shape、连续输出、输出不与输入共享存储、输入不变。零容差只适用于本复制／重排任务。

计时覆盖完整调用中的全部设备 kernel，返回原生平均耗时，不含 CPU 发射时间。不能把它解释成 p50 或逐轮采样分布。原 `test.py` 作为来源保存，不作为 SDK 设备检查器。

开启 profiling：在上述命令后增加 `--profile`。默认不使用 profiling 缓存；普通采集失败会单独记录，正确性和计时仍可有效。取消或清理未确认会停止实验。

### Recipe、Policy 与 SDK 版本

当前配置使用 `application.plugin`、`policy.id` 和 `bindings.<name>.plugin`，三个算子 Policy 使用显式 `state_schema/state` 及统一 `steps/type`。旧 `init/loop/finish` 检查点不迁移；已有实验使用原构建审计或恢复，新构建使用新的实验 ID。业务结果中的 `phase: static/metrics` 仍表示算子搜索阶段，与已删除的 Runtime 阶段标签无关。

`package.json` 和 `pnpm-lock.yaml` 固定包含严格评测、关联证据计时审计和 Default/MSTX 诊断的 Evaluator 提交。SDK 对应 [Evaluator PR #11](https://github.com/evolving-foundry/ember-evaluator/pull/11)；该 PR 合入前，需要保留固定提交，不能替换为缺少这些能力的主线版本。`pnpm install --frozen-lockfile` 使用该提交构建 SDK；`pnpm check` 与 `pnpm check:package` 验证本地行为和独立安装包消费，不执行模型或 NPU。

## 结果与恢复

运行数据位于 `.rsi/operator-sdk/<id>/`：

- `manifest.json`：`rsi.operator-inputs/v2` 输入快照，记录当前构建、实际安装的 SDK 与执行参数身份。
- `inputs/`：实际使用的 Recipe、目标、baseline、参考、任务契约，以及 `runtime/` 中冻结的 RSI 构建与 Policy 资源。
- `summary.json`：实验状态、两次测量、SDK runId、用量、诊断、清理状态及最终源码路径。
- `best-input.py`：选中源码；默认与初始 baseline 相同。

Manager 的候选、测量、调用回执和不可变证据继续保存在同一仓库 `.rsi/` 数据区。摘要中的 artifactRef／MeasurementRef 可追溯到这些记录；不能只复制摘要就声称实验可恢复。

```bash
node scripts/run-operator-sdk.mjs \
  --id top3-sdk-baseline-001 \
  --python /opt/operator-env/bin/python \
  --device 0 \
  --resume
```

恢复时需保持 Python、设备、profiling 开关、快照和正在使用的构建身份一致。完成回执不会重新测量或扣费；设备调用或清理未确认时停止自动重放，先核对保留的 SDK 目录及回执。构建或配置改变时用新 ID 开始实验。新入口不接受旧 `rsi.operator-demo-inputs/v1` 快照直接恢复；旧材料及其原构建保留用于离线审计。

`candidateValid` 为 1／0／不可用；`latencyMeanMs` 是候选均值，`referenceMeanMs` 是 PyTorch 参考均值，`speedupVsReference` 是两者的比值。相同 baseline 两次测量不构成代码优化收益。候选与参考的稳定性遵循下文 M2 标准；此前未通过的校准不能提供性能晋升阈值。

实际 Python、torch、torch_npu、Triton、CANN、驱动或设备身份缺失时，RSI 保存证据并停止比较。不要用人工填入的环境版本或虚构耗时绕过此条件。`realNpuRuns: null` 表示 SDK 没有报告精确物理执行次数，不能解释为零。

## 无 NPU 回归入口

```bash
pnpm check
pnpm check:package
```

默认检查不请求模型或 NPU。SDK worker fixture 只在测试中显式接入，生产 Recipe 没有自动 fallback。独立安装包检查通过复制到包外的实验材料执行 SDK fixture baseline，验证包内插件、Policy、SDK 和 Python 检查资源能够一起加载。

## M2：950PR 部署与预检

目标为在同一 NPU 环境部署 RSI 与锁定 SDK，昇腾 950PR、CANN 9.1.0、openEuler、1 NPU、32G 主机内存、32 核 CPU、300G 存储。32G 不等于设备显存，显存以 `npu-smi` 的实际输出为准。复用平台兼容的 PyTorch／torch_npu／Triton-Ascend，不默认更换驱动和 CANN。

以 RSI 的 `package.json` 和 `pnpm-lock.yaml` 锁定 SDK 提交。运行 `pnpm install --frozen-lockfile`、`pnpm check` 和 `pnpm check:package`，确认安装、构建和独立包消费通过。记录 RSI 提交、锁文件与实际设备环境；不依赖相邻仓库的未提交修改。

先向平台核实设备独占、会话寿命、磁盘持久化、目录可写和剩余容量，选定解释器的绝对路径。静态预检只查询版本和资源，不分配设备；未运行烟测时 `ready=false` 是预期结果：

```bash
node scripts/check-operator-npu.mjs \
  --id top3-static-001 --python /opt/operator-env/bin/python --device 0
```

人工核实平台条件后，用新 ID 执行一次逐元素加一任务的完整 SDK 烟测。参考与 Triton 实现均执行设备 kernel，避免纯复制由 DMA 完成而没有 kernel 计时记录。下例的人工观察内容必须替换为本次实际核实结果：

```bash
node scripts/check-operator-npu.mjs \
  --id top3-preflight-001 --python /opt/operator-env/bin/python --device 0 \
  --smoke --platform-checks '已核实本次设备独占、持久目录和会话时限；实际观察记录……'
```

结果在 `.rsi/operator-preflight/<id>/report.json`，保留实际 Python 包、OS、驱动／固件、CANN、设备、资源与 msprof 查询结果，以及依赖检查和烟测目录。烟测单列为至多 1 次 SDK 评测，不计入 top3 的 22 次预算；启动前取消计为 0 次。失败或清理未知时停止，不把路径改成另一个 Python 自动重试。缺少完整关联、固件／驱动等必需证据时先查原因，不手工填写版本或篡改报告使其通过。

当前严格计时同时采集 CPU 和 NPU activity，对采集内每次包装调用执行 `prof.step()`。证据使用 `schemaVersion: 2`、`method: profiler-flow/v1`，保留未改写的 `kernel_details.csv` 与 `trace_view.json` 及各自 SHA-256。Evaluator 将每个 CSV kernel 与 trace 中的设备事件对应，再沿 CPU→NPU flow、必要时沿 enqueue→dequeue 关联，定位 CPU `ProfilerStep`。原始 CSV 的 Step 标签只保留用于诊断，不能替代完整关联证据。

CPU 记录只用于归属，CPU 耗时不计入均值。逐次核验覆盖、唯一性、顺序和设备，按关联得到的 Step 排除采集内预热，再归约有效设备 kernel 耗时。RSI 从归档 CSV 与 trace 独立复核归属及均值。缺失、重复、歧义或冲突关联均使评测失败；不按行数拆分，也不靠 CPU／设备时间区间交叠猜测。每轮可以包含不同数量的 kernel。

使用新协议须重新构建并创建新的预检与实验 ID；旧 v1 记录保留为历史证据，不与新协议结果混合或直接续跑。

## M2：首次闭环、两批校准及恢复

保持源码、依赖、构建和设备环境不变，使用通过的预检报告：

```bash
node scripts/run-operator-calibration.mjs \
  --id top3-m2-001 \
  --preflight .rsi/operator-preflight/top3-preflight-001/report.json
```

入口串行执行：首次双测 2 次 → 完成恢复验证 → 第一批 5 个双测实验 → 至少 600 秒间隔 → 第二批 5 个双测实验。每个子实验的预算保持 2 次评测、0 次模型调用；共 22 次 SDK 评测，只有正式 20 次进入统计。每个子实验固定输入快照、构建身份、选定 Recipe、协议和 ID；当前构建或输入不同会停止。

首次闭环自动核验完整输出、零容差、baseline 源码不变、两个不同 SDK runId、原始计时复算、实例释放和清理确认。正式每次测量执行同样核验。候选与参考分别检查两批和合并 CV ≤ 3%、批中位数漂移 ≤ 3%、10 对差异全部 ≤ 5%；所有原始值保留。主协议是采集外 5 次预热，加采集内 5 次预热和 20 次有效调用。

需要独立 profiling 时，在**新建**集合时增加 `--profile`，末尾另做一个双测实验，总预算为 24 次。profiling 不混入校准；工具版本、原始文件、源码、参数、诊断来源和清理证据齐备才标记就绪。普通 profiling 失败可以与“性能可比较”并存。默认不使用 profiling 缓存，其内部重试仍受 Recipe 中显式上限约束。

```bash
node scripts/run-operator-calibration.mjs \
  --id top3-m2-001 \
  --preflight .rsi/operator-preflight/top3-preflight-001/report.json \
  --resume
```

完成后恢复会核验事实、回执、引用和用量，不新增评测。被中断但尚未启动的后续实验可继续；已存在失败／运行中／未知事实时禁止自动重试。发现失败后保存部分报告并停止后续设备工作，不能补几个成功样本拼成通过。

同一工作目录的 `.rsi/operator-calibration/device.lock/` 由 M2 批量入口和 smoke 共用。入口先检查该目录全部算子调用、测量、实例与清理事实；换一个集合 ID 不能绕过旧的未知状态。未确认清理或强制终止进程会保留所有权记录及锁；先核实旧进程和全部 SDK 子进程确实退出、设备空闲、回执及清理状态，再人工处理残留锁。删除锁不等于修复未知调用，未知事实仍会阻止恢复。其他工作目录及其他用户的占卡仍靠平台独占约束管理。

## M2：离线报告与唯一协议调整

```bash
node scripts/report-operator-calibration.mjs --id top3-m2-001
```

该命令只读取快照、Manager 事实及原始制品，不查询设备、不触发 SDK 运行。生成 `.rsi/operator-calibration/<id>/report.json` 和中文 `report.md`，分列基础闭环、性能比较、恢复和 profiling；无效／缺失证据保持未通过。fixture 报告显示“测试证据”，即使数值稳定也不输出可用的 N／T。

真实正式样本全部通过后，报告给出候选最大成对差异 N，以及 `T=max(0.05,2*N)`。T 只供 M3 初筛设计参考，不自动修改 Selector。

仅当主协议完整完成且唯一失败原因是噪声、已排除环境／采集故障并有证据支持预热或重复不足时，准备一份诊断文件，记录原始证据引用、排查过程和调整依据：

```bash
node scripts/run-operator-calibration.mjs \
  --id top3-m2-adjusted-001 \
  --preflight .rsi/operator-preflight/top3-preflight-001/report.json \
  --adjust-from top3-m2-001 --diagnosis .rsi/operator-calibration/top3-m2-001/diagnosis.md
```

该入口先重算父集合报告，要求源码／构建和环境身份相同，保存诊断原文与一次性调整登记。新集合使用 10／100 协议另做完整 20 次正式评测，第一对重新核验计时；不混入旧样本，不降低阈值。调整登记在异常后也不自动释放，防止重复消费预算。调整后仍不稳定则停止 M3 性能晋升。配置、构建、计时器或源码修正应新建基线流程，不能借协议调整绕过。

归档时保留整个 `.rsi/`、实际三仓源码及未提交差异、输入／构建快照、预检 SDK 目录、Manager 事实和不可变制品。批量目录里的报告与引用只是索引，不能单独用于恢复。原始设备信息留在受控实验材料中，对外分享时脱敏；不要复制凭据或完整环境变量。

真实 Agent 静态搜索以当前 baseline 正确、SDK 可执行及清理可确认为运行条件；M2 校准与独立复测用于标记结果可信度，不默认阻止候选生成。详见 [静态搜索入口](./static-search.md)。M2 本身不声明已有算子优化收益；profiling 驱动策略仍需独立采集证据。
