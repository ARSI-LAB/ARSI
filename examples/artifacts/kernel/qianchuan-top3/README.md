# Qianchuan top3 SDK baseline

本示例通过真实 Evaluator SDK 评测原始 Triton-Ascend baseline，并对相同源码独立复测。使用 `policy.operator-baseline`，只绑定 Evaluator 和 Selector；不配置 Agent、Proposer 或 embedding，不调用模型，也不生成优化源码。

任务接收 shape `[381, 51200]` 的 FP16 张量，返回 shape `[381, 80, 80, 8]`、连续且独立存储的 FP16 张量，保持输入不变。固定 case 为 `fixed`，seed 为 42，数值容差为零。候选入口为 `kernel_function`；参考、契约及来源测试位于 [task](./task/task.json)。SDK 严格检查器负责实际正确性验证。

在已安装锁定版本 SDK 的 NPU 主机上，从 RSI 根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build
node scripts/run-operator-sdk.mjs \
  --id top3-sdk-baseline-001 \
  --python /opt/operator-env/bin/python \
  --device 0
```

Python 路径需替换为实际解释器。结果保存在 `.rsi/operator-sdk/<id>/` 及 Manager 的 `.rsi/` 数据区；两个独立 runId 表示两次 SDK 评测。恢复已完成实验不会增加评测用量，仍需保持构建、执行参数和快照身份一致。

完整部署、预检、计时口径、校准与恢复步骤见 [SDK 实验说明](./sdk-experiment.md)。默认检查通过测试专用设备 worker 验证软件链路，不能据此声称真实 NPU 精度、性能或优化收益。生产配置仅支持 SDK 执行，不自动回退到模拟结果。

本示例的任务副本准备自相对于仓库根目录的 `../../kernel-tasks/qianchuan_top3_kernel`。该路径只用于准备材料，运行示例读取仓库内副本。原始文件保持完整；复制时仅将 CRLF 规范化为 LF，未修改其他内容，已有版权和许可声明均已保留。

| 原始文件     | 原始字节 SHA-256                                                   | 仓库副本 LF UTF-8 字节 SHA-256                                     |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `input.py`   | `de4a94cc5092f5260b414609af0f34e4c12b5db4e1bedc0b78d18de2913c6d81` | `cfbd24fab79b29be38e9c4ebdd4298be60310ad5c9db31bfdcf3f245fd973bd8` |
| `problem.py` | `1ae6e43d88d15ca0a6211662d2978dc59b8b1cc04c81f32df25b7140c64aecd8` | `8e4afaa3a4dde97a95f65dec490402cd2f93103af9c0201800f53883414f8f6a` |
| `test.py`    | `045f9d743e59fd97624885eec3fa894b9496820c3f8494208d594eb01f943dfe` | `407feea703eb23bc7eff8757edff5928841c1e76d29e205fd81f13ecea21a796` |

复制的 `test.py` 保留原始适配逻辑作为来源材料，实际执行使用 SDK 的冻结参考与严格检查器。原始源码中的 `time_taken_ms` 等历史元数据不作为本次测量结果。静态搜索已通过独立的 [搜索 Recipe](./recipe.search.yaml) 接入；部署、准入和执行步骤见 [静态搜索实验说明](./static-search.md)。baseline 示例不调用该路径，也不作代码改善声明。
