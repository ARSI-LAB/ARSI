# 推理参数搜索

[English](../en/parameter-search.md) | 简体中文 · [用户指南](guide.md)

每个实验选择一种 Policy，两者共用 `application.inference`、`evaluator.inferencebench` 和 `selector.metric`：

| Policy                    | Proposer          | 搜索方式                     | 是否需要 Python |
| ------------------------- | ----------------- | ---------------------------- | --------------- |
| `policy.parameter-grid`   | `proposer.grid`   | 枚举显式指定的 JSON 参数选项 | 否              |
| `policy.parameter-optuna` | `proposer.optuna` | Optuna TPE 或随机采样        | 是              |

原 `policy.vllm-autotune` ID 已移除，Recipe 应改用 `policy.parameter-grid`。引用旧 Policy 的历史实验不会自动迁移以支持恢复。[vLLM 推理示例](../../../examples/artifacts/inference/parameter-grid/README.md) 仍是配置 Application、远程启动、负载、指标和预算的起点。

完整的 [TPE Recipe 示例](../../../examples/artifacts/inference/parameter-tpe/README.md) 使用 `shared/` 中的公共部署资源，在四次评估预算内设置两次启动采样。

## 安装 Optuna 的 Python 环境

在 RSI 控制机上使用 Python 3.10–3.13，创建环境并安装固定版本的算法依赖：

```sh
python3.11 -m venv .scratch/optuna-venv
.scratch/optuna-venv/bin/python -m pip install -r src/plugins/proposer-optuna/python/requirements.txt
.scratch/optuna-venv/bin/python -B tests/integration/optuna-worker.py
RSI_OPTUNA_PYTHON="$PWD/.scratch/optuna-venv/bin/python" node --import tsx --test tests/integration/optuna-worker.test.ts
```

使用已安装的包时，依赖文件位于 `node_modules/ember-rsi/dist/src/plugins/proposer-optuna/python/requirements.txt`。将 `python.executable` 指向该环境的解释器；含 `/` 的可执行路径应使用绝对路径，单独的命令名通过 PATH 查找。可设置 `python.timeoutMs` 来限制单次 worker 调用的用时。RSI 不会自动安装 Python 依赖。查询目录和 Recipe Schema 校验不会启动 Python；实验初始化会在首次评测前检查解释器以及固定版本的 Optuna、NumPy。

上述 Python 测试命令显式调用真实 Optuna 运行合成输入检查，包括历史重放；Node.js 测试将真实 worker 输出交给 TypeScript 参数校验。默认 `pnpm check` 使用不依赖 Python 的本地确定性测试。运行 `pnpm check:package` 时设置 `RSI_OPTUNA_PYTHON`，还能在源码目录之外验证安装包中的 Python worker。

## 配置搜索

以推理示例为起点，用以下片段替换其 `policy` 和 `bindings.proposer` 部分，保留 Application、Evaluator、Selector 和预算配置，并按目标试验次数增加评测与操作预算：

```yaml
policy:
  id: policy.parameter-optuna
  config:
    maxTrials: 50
bindings:
  proposer:
    plugin: proposer.optuna
    config:
      path: tuning.json
      python:
        executable: /absolute/path/to/venv/bin/python
        timeoutMs: 30000
      sampler:
        type: tpe
        seed: 42
        options:
          startupTrials: 10
          eiCandidates: 24
          multivariate: false
      constraintHandling: native
      maxSamplingAttempts: 1000
      searchSpace:
        - name: max_num_seqs
          distribution: int
          low: 16
          high: 128
          step: 16
        - name: max_num_batched_tokens
          distribution: categorical
          values: [1024, 2048, 4096, 8192]
```

用户定义参数空间并确认引擎兼容性。`path` 指定一个可编辑的 JSON 对象文件，参数名是其顶层键，未搜索的字段沿用 baseline。Application 继续执行 Target 与候选合法性校验。不要搜索同时被 Application 校准逻辑覆盖的参数，例如启用自动显存校准时的 `gpu_memory_utilization`。

| Distribution  | 必填字段                              | 可选字段                              |
| ------------- | ------------------------------------- | ------------------------------------- |
| `categorical` | `values`：不重复的 JSON 标量选项      | 无                                    |
| `int`         | `low`、`high`：包含端点的安全整数边界 | `step`（默认 1）、`log`（默认 false） |
| `float`       | `low`、`high`：包含端点的有限数值边界 | `step`、`log`（默认 false）           |

指定步长时边界必须对齐。对数采样要求边界为正数；对数整数采样只能使用步长 1，对数浮点采样不能指定步长。Optuna 的类别选项不能是数组或对象，也不接受 `[true, 1]` 这样的布尔值与数字歧义组合；原生 grid 继续支持任意 JSON 选项。本优化器不新增引擎特有的跨参数校验或硬件可行性分析。

随机搜索替换以下配置即可：

```yaml
sampler:
  type: random
  seed: 42
  options: {}
constraintHandling: selection-only
```

TPE 的 `options` 只接受 `startupTrials`、`eiCandidates` 和 `multivariate`，random 不接受算法选项。TPE 默认使用 10 次完成的启动试验、24 个 EI 候选并独立建模各参数。试验次数不超过启动阈值时，可能不会进入自适应 TPE 阶段。本版不支持 GP、CMA-ES、QMC、多目标优化、条件参数空间或任意 Python 回调。

## 反馈、限制与恢复

Selector 配置是目标指标、方向、负载点、统计量和 SLO 约束的唯一来源。TPE 的 `native` 模式把约束用于后续采样；`selection-only` 不约束采样，但 Selector 仍然排除不满足条件的交付候选。random 必须使用 `selection-only`。

每次完整评测都会反馈，包括没有被采用或违反 SLO 的候选。失败、不完整评测、无效指标、部署失败和取消都不会被转换成虚构低分，继续使用现有 Runtime 的失败处理与资源清理机制。

Proposer 通过 [contract.proposer-parameter-search](../../../src/contracts/plugin-types/proposer-parameter-search.ts) 实现 `initialize`、`suggest` 和 `observe`。不可变搜索状态存入 `.rsi/artifacts/`，Policy 检查点保存最新的 `stateRef`。Python 重放历史 ask/tell 以重建 Study，再生成下一组建议。同时只允许一个待评测 trial，相同反馈重复提交不会增加观察。搜索配置、worker 身份、环境版本、目标或比较条件变化时，不能静默复用不兼容的历史。

重复参数组合会记录并跳过，不再执行评测。Proposer 的可选字段 `maxSamplingAttempts` 限制总采样次数，包含重复采样。Optuna Policy 的 `maxTrials` 限制新增评测次数（默认 50，最大 1,000），grid Policy 的 `maxCandidates` 限制网格评测次数（默认 1,000，最大 100,000）。搜索可在穷尽有限空间或达到适用上限时结束。Python 采样及重复尝试计入已配置的实验墙钟预算。

结果包含最优可行候选的 `candidateRef`、`measurementRef`、`parameters`，全部测量引用 `measurementRefs` 和 `searchStateRef`。停止原因包括 `max-trials`、`search-exhausted`、`sampling-limit`；采样达到上限不代表已经穷尽空间。没有可行结果时返回 `no-feasible-configuration`，最优候选字段为空。选择结果本身不能证明统计意义上的性能改善，应在声称改善前复测所选配置。
