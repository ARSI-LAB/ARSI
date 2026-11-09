# Proposer task for the kernel-opt agent channel.

Optimize the captured Triton kernel in `input.py` for Ascend NPU. Each
round you receive the incumbent kernel source, last-round measurement
evidence, and the kernel-opt domain skill; return one candidate per round as
file edits:

- Rewrite at most the files in the editable scope (`input.py`, `config.json`).
- One structural change or one tiling adjustment per round; unmeasured
  candidates score nothing, so never bundle several experiments into one edit.
- The deterministic safety scan rejects non-kernel constructs; the evaluator
  checksum gate rejects wrong-but-fast candidates. You propose; you never
  adjudicate.

## 第一轮锚点 (anchor)

基线 `input.py`（占位示例为 vector add；实际部署时是被捕获的
`triton_poi_fused_add_0.py` 内核）已经是按绑定契约重构好的 4-D
strided-loop 内核（展平多维 grid 为线性块号跨步循环、全程 int32、store 沿
(y2,x3) 连续、load 沿 (z1,x3) 连续），在当前 `config.json` tiling 下已验证：
可编译、checksum 通过、约 1656µs。所以：

- 第一轮**只做一个 tiling 调整**（`config.json` 的 `*BLOCK`/`*SUB`/
  `num_warps`/`num_stages` 之一），保持内核结构不变。
- 后续轮次才可以一次改一个结构点（例如调整 SUB 切分方式、合并循环层级），
  每轮仍然只改一处。
- 不要重新引入 inductor 命名，不要改回一维 `x0_numel` 风格。

## 绑定契约 (最高优先级, 覆盖模板中"保持函数名与签名不变"的要求)

RSI 评估器自己加载并启动内核, **不使用** workspace 里的 wrapper.py, 所以
wrapper 的调用方式与候选是否可测无关。评估器按参数名绑定实参, 内核签名必须
严格满足:

- `in_ptr0`/`in_ptr1`: 工作负载输入张量 (评估器对每个 `in_ptr*` 传入同一输入)。
- `out_ptr0`: 预分配输出张量, 形状 (T0, Z1, Y2, X3) = (381, 80, 80, 8)。
- numel 标量只允许这四个名字: `t0_numel`, `z1_numel`, `y2_numel`, `x3_numel`。
- constexpr tiling 参数名必须是 `config.json` 的键: `T0BLOCK`/`T0BLOCK_SUB`,
  `Z1BLOCK`/`Z1BLOCK_SUB`, `Y2BLOCK`/`Y2BLOCK_SUB`。
- **禁止**使用捕获内核的归纳器命名 (`x0_numel`, `X0BLOCK`, `X0BLOCK_SUB`):
  评估器无法绑定这些名字, 候选会在测量开始前被 precheck 拒绝。
- launch grid 由评估器固定为
  `(cdiv(T0,T0BLOCK), cdiv(Z1,Z1BLOCK), cdiv(Y2,Y2BLOCK))`, 参数取自
  `config.json`; 内核按该 grid 编写 (用三个 pid 轴或在核内展平), 不要假设
  一维 grid。
- `config.json` 只包含 tiling 键和 `num_warps`/`num_stages`; 不要把内核
  参数名加进 config.json 来绕过本契约。
