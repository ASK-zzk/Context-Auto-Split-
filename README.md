<p align="center">
  <img src="./assets/logo.svg" width="96" height="96" alt="Context Auto-Split Logo" />
</p>

<h1 align="center">Context Auto-Split · 上下文自动分流多开插件</h1>

<p align="center">
  <strong>Google Antigravity 智能上下文保护与嵌套子对话自动分流插件（v1.2.2）</strong><br/>
  零外部依赖（仅需 Node.js） · 零额外 LLM 调用开销 · 按当前活跃模型窗口百分比动态守护
</p>

---

## 为什么需要这个插件？

在大型代码库改造或长链路排错中，主对话很容易因为**连续读多个文件、刷屏的编译/测试日志、多分支并行调查**而迅速膨胀到十几万甚至几十万 Token，进而引发：

- **上下文滚雪球**：主对话背着庞大的历史上下文继续走工具调用，导致高配主模型缓存读/计算成本飙升、响应变慢；
- **频繁触发 `/compact` 失忆**：早期关键约束和代码细节在压缩摘要中丢失，引发反复返工；
- **不同模型窗口差异大**：例如 Antigravity 中 `Gemini 4 Neon` / `Gemini 4 Hydrogen` 为 `512K`、`Gemini 4 Argon` / `Claude 5.5` 为 `1M`、`Claude 4.6` 为 `200K`、`Local LiteRT / Gemma` 仅 `64K`，静态写死的阈值要么对大窗口过早报警，要么对小窗口保护太晚。

**Context Auto-Split** 通过「**主从上下文隔离架构 + `PreInvocation` 实时 Token 水位守护 + 模型自适应校准**」，在不新建割裂会话的前提下，将重型读写与试错过程自动卸载到当前大对话内部的独立子对话（Subagent）中消化，让主对话始终保持轻量、清醒与可调度。

---

## 核心机制：上下文管理与模型自适应水位

### 1. 主对话 vs 嵌套子对话隔离架构

```text
主对话 (Main Orchestrator) —— 负责理解目标、拆解任务、调度子对话与最终汇总
  ├──► context-researcher (flash)   ：只读调研、搜代码、读长日志 ──► 仅返回 ≤ 250 字摘要 / 文件路径
  ├──► context-worker     (inherit) ：直达目标路径改代码、跑测试排错 ─► 仅返回 ≤ 250 字结果 / 验证结论
  └──► self               (inherit) ：依赖外部 MCP 或特定技能的任务 ──► 完成后销毁自身过程上下文
```

- **轻任务留在主对话**：普通问答、澄清需求、1～2 个小文件微调或短命令直接在主对话完成，避免无意义的冷启动开销。
- **重任务自动分流**：满足以下任一条件时，主对话自动通过 `invoke_subagent` 在当前会话内派发子对话吸收脏活：
  1. 阅读/探索 ≥ 3 个中等/大文件、全仓巡检或排查长日志/长文档；
  2. 多轮编译、测试、修复的调试循环（容易产生大量过程输出）；
  3. 存在 ≥ 2 个互不依赖的子任务（同波次并发派发）；
  4. 长对话中切入独立支线任务。
- **Plan Mode 保护**：在只读规划阶段仅派发只读 `context-researcher` 调研，代码修改与命令验证留待执行阶段再交给 `context-worker`。

### 2. 零 Token 开销的 `PreInvocation` 实时监控

每次主模型思考前，`hooks.json` 会同步触发零依赖脚本 `scripts/context_guard.mjs`：

1. **毫秒级日志读取**：读取当前会话 `transcript.jsonl` 最近一条含统计字段的 `PLANNER_RESPONSE`，计算真实上下文水位：
   $$\text{currentTokens} = \text{input\_tokens} + \text{cache\_read\_tokens} + \text{output\_tokens}$$
   对于超过 `6 MB` 的超长日志，脚本按 `16 KB` 步长读取文件首行（上限 `256 KB`，识别会话出身）与文件尾 `4 MB`（提取最新 Token 与子对话记录），实测耗时 `< 50 ms`，且**不消耗任何 LLM Token**。
2. **纯 `systemMessage` 稳定投递**：Hook 严格输出 `{ injectSteps: [{ systemMessage: { systemMessage } }], terminationBehavior: "" }`（**刻意不附带 `metadata` 字段**），确保在 Antigravity 宿主运行时 100% 稳定送达模型上下文而不被静默丢弃。

### 3. 按当前活跃模型窗口百分比动态分档

插件不把所有模型一刀切为固定的 `200k`，而是每轮动态解析当前活跃模型：

1. **活跃模型识别**：优先读取 Hook 输入中的 `input.modelName`（若为 `"auto"` 或为空，则自动回退读取 `transcript.jsonl` 中最近一次 `PLANNER_RESPONSE.model`）；
2. **最长键优先匹配**：在 `config.json` 的 `modelWindows` 中按**键长度从长到短**做不区分大小写子串匹配（确保 `claude-opus-4-6-1m` 命中 `1M` 而不会被泛化键 `claude` 的 `200K` 截断）；
3. **四级百分比水位护栏**（默认 `thresholdMode: "percent"`）：

| 水位级别 | 触发条件（占当前模型窗口） | 注入主对话的行为约束 |
| :--- | :--- | :--- |
| **`BURST`** | 占比 `≥ 20%` **且** 单轮工具输出 `≥ 24 KB` | 提醒本轮已产生较重工具输出，后续多文件阅读或长命令应分流至子对话（每轮最多触发一次） |
| **`WARM`** | 占比 `≥ 40%` | 主动分流状态：非平凡文件阅读、代码修改与构建测试循环一律交由子对话 |
| **`HIGH`** | 占比 `≥ 65%` | **严格纯调度模式**：禁止在主对话内广泛 `read_file` 或跑构建/测试 `run_command` 循环，并列出本会话已登记的子对话 ID 提示优先 `send_message` 复用 |
| **`CRITICAL`** | 占比 `≥ 85%` | 保持严格纯调度模式，并在本轮回复末尾明确提醒用户输入 `/compact` 压缩主上下文 |

- **冷却防抖**：进入 `HIGH` / `CRITICAL` 后，需继续增长至少 **`15%`（`reAlertDelta`）** 才会再次提醒，避免连续每步刷屏。

### 4. 模型窗口对照与平台边界说明（显式官方表 + 压缩自校准）

**关于平台边界的坦诚说明**：Antigravity 公开的 `PreInvocation` Hook 输入与 `transcript.jsonl` 仅暴露了模型名称（`model`）与已用 Token 数，**并未直接下发后端给该模型分配的 `maxContextTokens`**。因此本插件采用「**官方核实上限表 + 历史压缩峰值自校准**」双保险机制：

| 模型系列（匹配键） | 默认窗口上限 | `WARM` (40%) | `HIGH` (65%) | `CRITICAL` (85%) | 来源与备注 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`gemini-4-neon` / `gemini-4-hydrogen`** | `512K` (`512,000`) | `205k` | `333k` | `435k` | Neon 核实自官网 `/docs/models`，Hydrogen 按用户实测锁定（显式锁定） |
| **`gemini-4-argon`** | `1M` (`1,048,576`) | `419k` | `682k` | `891k` | 核实自 Antigravity `/docs/cli/statusline.md`（显式锁定） |
| **`claude-opus-5-5` / `claude-sonnet-5-5`** | `1M` (`1,000,000`) | `400k` | `650k` | `850k` | 核实自关联 Cloud 文档（显式锁定） |
| **`claude-*-1m`** | `1M` (`1,000,000`) | `400k` | `650k` | `850k` | 长上下文 1M 变体（显式锁定） |
| **`claude`**（如 `claude-sonnet-4-6`） | `200K` (`200,000`) | `80k` | `130k` | `170k` | 泛化家族默认值 |
| **`gpt-4.1`** | `1M` (`1,000,000`) | `400k` | `650k` | `850k` | 显式锁定 |
| **`gpt-5`** | `400K` (`400,000`) | `160k` | `260k` | `340k` | 显式锁定 |
| **`o3` / `o4`** | `200K` (`200,000`) | `80k` | `130k` | `170k` | 显式锁定 |
| **`gpt-4o` / `gpt-oss`** | `128K` (`128,000`) | `51.2k` | `83.2k` | `108.8k` | 显式锁定 |
| **`gemma` / `litert`** | `64K` (`64,000`) | `25.6k` | `41.6k` | `54.4k` | 核实自 Antigravity `/docs/sdk/local-models.md`（显式锁定） |
| **`gemini`** / 未收录模型 | `1M` / `512K` | 动态 | 动态 | 动态 | 泛化兜底 + 支持双向压缩校准 |

- **压缩上限自校准（`autoCalibrateFromCompaction`）**：
  - 对于官网未公布具体上限、仅命中泛化键（`"gemini"` / `"claude"`）或未命中任何键的模型（例如 `gemini-4-carbon-*` 或全新未知模型），一旦主对话发生压缩回落（当前 Token 降至峰值 `65%` 以下且此前峰值 `≥ 32k`），脚本会把压缩前的峰值记入状态目录的 `observed_windows.json`（保留最近 5 次并取中位数 `ceiling`）。只要实测 `ceiling ≥ 32k`，无论高于还是低于默认兜底窗口（支持**向上扩展**与**向下收缩**双向自校准），后续均自动按实测上限计算百分比。
  - **显式钉死的型号键（如 `gemini-4-neon`、`gemini-4-hydrogen`、`gemini-4-argon`）永远不会被通用校准覆盖**。
- **中途切换模型自适应**：若从大窗口（如 `512k`/`1M`）切到小窗口（如 `200k`），占比升高会立即触发对应高水位提醒；若从较小窗口切往严格更大的窗口（如 `512k` 切往 `1M`），会立即重置旧警戒层级与冷却记录，确保新窗口下的 `WARM`/`HIGH` 提醒不被旧的小窗口状态抑制。
- **`/compact` 重置**：一旦检测到 Token 跌破峰值的 `65%`（`compactDropRatio`），自动将水位重置为 `normal`，避免压缩后仍卡在 `CRITICAL` 状态。

### 5. 子对话复用、并发上限与防套娃保护

- **并发上限与批量合并**：每波次最多并行开启 **`3` 个**（`maxParallelSubagents`）子对话，零碎小范围查询强制合并进同一个 `context-researcher`，避免过度冷启动。
- **同仓库优先复用**：`context_guard.mjs` 自动解析历史 `invoke_subagent` 返回的子对话 UUID 并持久化至 `children.json`（7 天过期清理）；同一仓库或相邻模块的后续工作优先通过 `send_message` 复用已有子对话，同时要求主对话将调研阶段拿到的**精确文件路径与行号**直接透传给 `context-worker`，避免重复全仓扫描。
- **三重防递归识别**：通过 `children.json` 注册表、提示词前缀 `[CONTEXT_AUTOSPLIT_CHILD]` 以及 `step 0` 的非 `USER_EXPLICIT` 来源三重识别子对话，**严禁子对话再次多开**。
- **子对话双重封顶保护**：子对话的收尾提醒上限为 $\min(\text{childCriticalTokens},\ \text{round}(0.75 \times \text{activeWindow}))$——即在 `1M / 512K / 200K` 模型下均于 `150K` 静默提醒子对话收尾汇总，在 `128K` 模型下于 `96K` 收尾，在 `64K` 模型下于 `48K` 收尾。

### 6. 额度与成本经济学

- **什么时候显著省额度？** 长对话（`> 40%` 窗口）、跨多文件深调研、反复构建排错。`context-researcher` 自动降档到更便宜快速的 `flash` 模型，替高配主模型挡掉数百次读文件与长日志；主对话只吸收 `≤ 250` 字结构化摘要，避免主上下文被滚雪球式推高。
- **需要注意什么？** 每个新子对话有约 `6k～10k` 的系统指令冷启动成本；极小的 1～2 个文件微调不要拆，同一仓库连续改码应复用已有 `context-worker` 而非频繁新开。如果希望极端保守省额度，可将 `config.json` 中的 `mode` 设为 `"threshold-only"`（仅过线后才开始分流）。

---

## 快速安装

> 前置条件：已安装 **Node.js**（用于运行零依赖 `PreInvocation` Hook，无需 `npm install`）。

### 方式一：Git Clone 到全局插件目录（推荐）

**Windows (PowerShell)**：
```powershell
git clone https://github.com/ASK-zzk/Context-Auto-Split-.git "$HOME\.gemini\config\plugins\context-autosplit"
```

**macOS / Linux**：
```bash
git clone https://github.com/ASK-zzk/Context-Auto-Split-.git ~/.gemini/config/plugins/context-autosplit
```

### 方式二：通过 Antigravity CLI 安装

```bash
agy plugin install https://github.com/ASK-zzk/Context-Auto-Split-.git
```

安装后 Antigravity 会自动发现并加载该插件（可在左侧 **Skills & Customizations** 中查看或一键开关），下一轮对话起自动生效。

---

## 配置项详解 (`config.json`)

直接修改插件根目录的 [`config.json`](./config.json) 即可实时生效，无需重启应用：

| 字段 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `enabled` | `true` | `PreInvocation` 上下文守护 Hook 总开关 |
| `mode` | `"hybrid"` | `"hybrid"`（智能混合：重任务主动分流 + 水位升级）、`"orchestrator"`（第 1 轮起纯调度）、`"threshold-only"`（仅按水位触发） |
| `thresholdMode` | `"percent"` | `"percent"`（按活跃模型窗口百分比动态缩放）或 `"tokens"`（兼容旧版固定 Token 阈值：`windowTokens` / `thresholds` / `burstMinTokens` / `reAlertDeltaTokens`） |
| `defaultWindowTokens` | `512000` | 模型名未知或未命中 `modelWindows` 时的默认上下文窗口上限（`512K`） |
| `autoCalibrateFromCompaction` | `true` | 对仅命中泛化键（`"gemini"` / `"claude"`）或未收录的模型，从历史压缩峰值双向学习实际窗口（可扩可缩）并写入 `observed_windows.json`；显式型号键不被覆盖 |
| `modelWindows` | 对象 | 模型名子串到窗口 Token 数的映射表（最长键优先、不区分大小写） |
| `thresholdPercents.burstMin` | `20` | 触发 `BURST` 单轮大输出提醒的最低上下文占比（%） |
| `thresholdPercents.warm` | `40` | 触发 `WARM` 主动分流状态的占比（%） |
| `thresholdPercents.high` | `65` | 触发 `HIGH` 严格纯调度模式的占比（%） |
| `thresholdPercents.critical` | `85` | 触发 `CRITICAL` 纯调度 + `/compact` 提醒的占比（%） |
| `thresholdPercents.reAlertDelta` | `15` | 在 `HIGH` / `CRITICAL` 同档位内再次提醒所需的新增占比（%） |
| `heavyToolBurstBytes` | `24000` | `hybrid` 模式下单轮 `GENERIC` 工具输出触发 `BURST` 的字节阈值 |
| `compactDropRatio` | `0.65` | 当前 Token 跌破 `peakTokens * compactDropRatio` 时判定为已压缩并重置水位 |
| `maxChildDepth` | `1` | 子对话最大允许嵌套深度（默认禁止子对话再派生） |
| `childCriticalTokens` | `150000` | 子对话收尾上限（实际生效上限为 `min(childCriticalTokens, 0.75 * activeWindow)`） |
| `maxParallelSubagents` | `3` | 单波次建议并发子对话上限 |
| `models.heavy` | `"inherit"` | `context-worker` 与 `self` 默认使用的模型 |
| `models.lightweight` | `"flash"` | `context-researcher` 默认使用的模型 |

---

## 项目结构

```text
context-autosplit/
├── plugin.json                         # Antigravity 插件清单
├── config.json                         # 运行时策略、模型窗口表与百分比阈值配置
├── hooks.json                          # PreInvocation 生命周期钩子注册
├── rules/
│   └── AGENTS.md                       # 常驻规则：混合分流策略、复用原则与水位服从规范
├── agents/
│   ├── context-researcher.md           # 只读调研子对话（默认 flash）
│   └── context-worker.md               # 读写执行子对话（默认 inherit）
├── skills/
│   └── context-autosplit/
│       └── SKILL.md                    # 手动拆单、水位检查与调参技能手册
├── scripts/
│   ├── context_guard.mjs               # 零依赖 Hook 主脚本（Token 监控、模型窗口解析、防递归与自校准）
│   └── test_context_guard.mjs          # 自动化单元测试套件（17 组场景）
├── assets/
│   └── logo.svg                        # 插件图标
├── LICENSE                             # MIT License
└── README.md
```

---

## 本地自检测试

插件自带覆盖 17 组核心场景的零外部依赖自动化测试（低水位静默、Burst 防抖、Warm/High/Critical 升级与冷却、子对话 ID 注册复用与严格锚定提取、`/compact` 重置、防套娃与 150k 封顶、超大日志长首行防误判、`orchestrator`/`threshold-only` 模式、Neon 512k / Argon 1M / Claude 5.5 / Gemma 64k 缩放、中途切模型升降级与大窗口重置、旧版 `tokens` 模式兼容、压缩峰值双向自校准与显式键保护、异常输入容错）：

```bash
node scripts/test_context_guard.mjs
```

---

## 已知局限与设计边界

1. **对 Antigravity 运行时约定的依赖**：本插件依赖宿主执行 `hooks.json` 时以插件根目录作为工作目录（`node scripts/context_guard.mjs`）、`PreInvocation` 输入/输出协议、`injectSteps` 使用纯 `systemMessage`（不附带 `metadata` 以防静默丢弃），以及 `transcript.jsonl` 中 `USER_INPUT` / `GENERIC` / `PLANNER_RESPONSE` 等步骤与 Token 字段结构；若未来宿主升级变更上述契约，需同步适配。
2. **软约束而非硬拦截**：`PreInvocation` Hook 负责实时水位监测并向模型注入分流或收尾指令，但并不硬性阻断单次工具调用；实际是否稳定执行 `invoke_subagent`、严格遵守并发上限与 `250` 字摘要规范，仍取决于当前活跃模型自身的指令遵循稳定性。

---

## License

[MIT](./LICENSE) © 2026 ASK-zzk
