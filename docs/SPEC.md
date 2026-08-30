# heluo-code 规格说明书（SPEC）

> 版本：v1.8 ｜ 日期：2026-08-30 ｜ 状态：P6-0 部分实施（会话持久化 JSONL 落地 + 进程级沙箱写限制：restricted-write/job 双模式；vitest 156 全绿 + e2e 9 用例全绿 + typecheck 全绿；网络隔离 P6-0b 进行中）
>
> 本文档是 heluo-code 项目的唯一规格来源（Single Source of Truth）的**主契约**。
> 架构 / 决策 / 领域模型 / 实施计划保留于此；接口类型、工具、权限、配置等密度高的详规外置于 `docs/specs/`（见目录索引）。
> 所有阶段性实现以本文档及引用详规为验收依据；文档与实现冲突时，先修订文档再改代码。

---

## 目录

1. [项目概述](#1-项目概述)
2. [术语表](#2-术语表)
3. [总体架构](#3-总体架构)
4. [技术选型与决策记录](#4-技术选型与决策记录)
5. [核心概念与领域模型](#5-核心概念与领域模型)
6. [接口规格（详规）](#6-接口规格详规) → [specs/interfaces.md](specs/interfaces.md)
7. [内置工具集（详规）](#7-内置工具集详规) → [specs/tools.md](specs/tools.md)
8. [权限系统（详规）](#8-权限系统详规) → [specs/permissions.md](specs/permissions.md)
9. [配置系统（详规）](#9-配置系统详规) → [specs/config.md](specs/config.md)
10. [客户端规格](#10-客户端规格) → [specs/desktop.md](specs/desktop.md)（§10.2 详规，P4a 起外置）
11. [分阶段实施计划](#11-分阶段实施计划)
12. [成熟项目借鉴对照表](#12-成熟项目借鉴对照表)
13. [风险与对策](#13-风险与对策)
14. [未决问题](#14-未决问题)

---

## 1. 项目概述

### 1.1 一句话定位

- **定位**：从零实现的 AI 编程助手 harness。
- **特征**：① 无头核心驱动 agent 循环，调用工具读写代码、执行命令完成真实编码任务；② 全面插件化架构（工具、Provider、Agent 定义均可由插件贡献）；③ 交付形态为桌面应用（Electron），开发期附带终端调试界面。

### 1.2 对标产品

Claude Code、OpenAI Codex CLI、opencode、DeepSeek Harness (dsh)、Qoder CN。

### 1.3 目标

| 编号 | 目标 | 衡量方式 |
|---|---|---|
| G1 | 完整可用的 agent loop + 工具集，能独立完成「写脚本→运行→修错」类真实任务 | P2 验收 |
| G2 | 全面插件化：工具、LLM provider、agent 定义均可由插件贡献，新增能力不改核心代码 | P3 验收 |
| G3 | 桌面应用中完成端到端编码任务，含流式渲染、权限确认卡片、Ask/Agent/Quest 三级模式 | P4 验收 |
| G4 | 多 agent 编排：主 agent 可派发子任务给子 agent 并汇总结果 | P5 验收 |
| G5 | 学习价值：核心机制均有清晰的接口边界与文档，便于逐层理解 harness 原理 | 全程 |

### 1.4 非目标（Non-goals，明确不做）

- 不做 IDE/编辑器集成（VS Code/JetBrains 插件）
- 不做云端/多机协同、账号体系
- 不做代码补全（NEXT 类功能）
- 不兼容 dsh/opencode 的插件协议（只借鉴设计，不追求二进制兼容）

> 注：进程级沙箱（Seatbelt/Landlock/Windows Restricted Token 等）**原列为非目标**，经评审调整为 P6 强制项（见 §11 P6-0 与 §13 R8）——v1 仅以权限 + 工作目录软约束为防线，但安全隔离在 P6 补上。

---

## 2. 术语表

| 术语 | 含义 |
|---|---|
| **Harness** | 包裹 LLM 的运行时骨架：agent 循环、工具执行、会话管理、权限控制的总和 |
| **Agent Loop** | 核心循环：用户输入 → LLM 推理 → 工具调用 → 结果回传 → 继续推理，直至产出最终回答 |
| **Turn（回合）** | 从接收到一次用户输入开始，到不再欠任何工作为止的完整周期；一个 turn 包含零或多个 step |
| **Step（步骤）** | 一次模型请求 + 该次响应所调用的全部工具执行 |
| **SessionEvent** | 会话日志中的原子事实记录（append-only），见 §5.2 |
| **Seam（接缝）** | 一个可替换能力的三角色组合：Service Definition（契约）/ Service Provider（实现）/ Consumer（消费方），借鉴自 dsh |
| **Cordis** | 开源插件框架（Koishi 生态），dsh 底层同款；提供服务容器、依赖注入、类型化事件、可逆副作用 |
| **Op / EventMsg** | 客户端→核心的提交指令 / 核心→客户端的事件消息（借鉴 codex 双队列协议） |
| **Ask / Agent / Quest** | 三级自主性模式：只读问答 / 读写需确认 / 预设边界内全权委托（借鉴 Qoder） |
| **PTC** | Programmatic Tool Calling，模型生成一段代码批量组合多轮工具调用的模式（dsh 的 Code Mode，本项目仅记录为远期方向） |

---

## 3. 总体架构

### 3.1 架构范式

采用业界验证过的「**无头核心（headless core）+ 薄客户端**」范式。core 包零 UI 依赖、零平台依赖，通过服务接口与事件流对外暴露能力；CLI 与桌面端都是它的消费者。

```
┌─────────────────────────────────────────────────────────────┐
│                      packages/desktop                        │
│   Electron main ──IPC(Op/EventMsg)── React 渲染进程          │
│        │ 加载 core 并组装 Context                             │
└────────┼────────────────────────────────────────────────────┘
          │ 进程内直接调用
┌────────▼────────────────────────────────────────────────────┐
│                      packages/core                           │
│                                                              │
│   Cordis Context（插件内核：挂载/卸载/依赖解析/可逆副作用）    │
│   ├── ctx.sessions     仅追加 SessionEvent 日志 + 投影       │
│   ├── ctx.llm          AI SDK 适配 seam（多 provider 注册制） │
│   ├── ctx.tools        工具注册表 + guarded 执行管线          │
│   ├── ctx.agents       Agent 接口 + 活跃注册表                │
│   ├── ctx.agentLoop    默认循环（Agent 接口的可替换实现）      │
│   └── 内置插件: tools-fs / tools-shell / permissions /        │
│                 system-prompt / subagent(P5)                  │
└────────┬────────────────────────────────────────────────────┘
          │ 进程内直接调用
┌────────▼────────────────────────────────────────────────────┐
│              packages/cli （开发调试 REPL，非交付物）          │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 仓库结构（pnpm workspace monorepo）

```
heluo-code/
├── pnpm-workspace.yaml
├── docs/
│   ├── SPEC.md                    # 主契约（docs/specs/ 为按域详规）
│   └── specs/                     # 接口/工具/权限/配置等密度高详规
├── packages/
│   ├── core/                      # @heluo-code/core
│   │   └── src/
│   │       ├── services/
│   │       │   ├── session/       # SessionEvent 日志、deriveMessages、内存 store
│   │       │   ├── llm/           # AI SDK 适配器封装、StreamChunk 归一化
│   │       │   ├── tools/         # 工具注册表、guarded 执行管线
│   │       │   ├── agent/         # Agent 接口、registry、factory
│   │       │   └── loop/          # 默认 agent loop（turn/step 驱动）
│   │       ├── plugins/           # 内置能力（均以 Cordis 插件形态存在）
│   │       │   ├── tools-fs/
│   │       │   ├── tools-shell/
│   │       │   ├── permissions/
│   │       │   ├── system-prompt/
│   │       │   └── config/
│   │       ├── shared/            # 公共类型、错误定义、工具函数
│   │       └── index.ts           # boot(profile) 入口：按序挂载插件树
│   ├── cli/                       # @heluo-code/cli，bin: heluo-code
│   │   └── src/index.ts           # readline REPL（P1–P3 的主要交互面）
│   ├── plugin-web-fetch/          # @heluo-code/plugin-web-fetch（P3 示范外部插件：web_fetch 工具）
│   └── desktop/                   # @heluo-code/desktop（P4 起）
│       ├── src/main/              # Electron 主进程：boot core + IPC bridge
│       ├── src/preload/           # contextBridge 白名单 API
│       └── src/renderer/          # React + Vite 聊天界面
└── vitest.workspace.ts
```

### 3.3 数据流（一次典型 turn）

```
用户输入
  → Op(user-turn) 提交
  → agentLoop 打开 turn，写入 session log ('turn/start')
  → system-prompt 组装提示词片段 + 工具 schema
  → sessions.deriveMessages() 从日志投影模型历史
  → ctx.llm.stream() 发起流式请求（AI SDK）
  → 流式 chunk 逐条写入 session log（assistant/chunk 等）并广播
  → 若返回 tool_call：
      → tools 管线 pre-execute 瀑布钩子（权限门在此拦截）
      → execute(args, ctx)，结果写入 session log ('tool/result')
      → 回到步骤「deriveMessages」，进入下一个 step
  → 无 tool_call 时写入 'assistant/message'，关闭 turn ('turn/end')
  → UI 由实时广播的 SessionEvent 流驱动渲染（从不轮询）
```

---

## 4. 技术选型与决策记录

### 4.1 选型总表

| 维度 | 选择 | 版本基线 |
|---|---|---|
| 语言/运行时 | TypeScript (strict) + Node.js，纯 ESM | Node ≥ 20 |
| 包管理与仓库 | pnpm workspace monorepo | pnpm ≥ 9 |
| 测试 | vitest | 最新稳定 |
| LLM 接入 | Vercel AI SDK（`ai` + `@ai-sdk/openai-compatible`；规格基线 v5，P0 核实时 npm latest 为 v7.0.83，P1 启动前定版，建议跟 v7 并复核 `stream()` 归一化） | v5（基线；P1 定版，建议 v7） |
| 插件基座 | Cordis `@cordisjs/core@4.0.0-beta.5`（P0 核实锁定；4.x 但为 beta，对应 R1 风险，core 内做薄封装隔离类型外泄） | dsh vendor 同源 4.x |
| 桌面壳 | Electron + electron-builder | 最新 LTS |
| 桌面前端 | React + Vite | 最新稳定 |
| CLI 交互 | Node 原生 readline（不引 TUI 框架） | — |
| 会话持久化 | JSONL 文件（每会话一文件）；SQLite 列为 P6 评估项 | — |

### 4.2 决策记录（ADR 摘要）

| # | 决策 | 结论与理由 | 被否决的备选 |
|---|---|---|---|
| D1 | 无头核心 + 薄客户端 | 三款标杆产品共同范式；core 天然复用 | 单体 CLI 应用（无法演进到桌面）；本地 HTTP server 层（单机单客户端场景属过度设计，留待多客户端需求出现再加） |
| D2 | Vercel AI SDK 作为 Provider 层 | 跨网关兼容已被生产验证（opencode 同款）；统一流式接口覆盖 DeepSeek/Qwen/Kimi/GLM/Ollama | 自研 fetch 客户端 ~200 行（学习价值高但重复造轮子，且 seam 已留好随时可替换）；openai npm SDK（国产网关抽象泄漏多：`reasoning_content` 缺失、部分网关拒收 `stream_options` 等） |
| D3 | Cordis 作为插件基座 | 「万物皆插件」有工业级地基；dsh vendor 同源，可直接精读其用法；服务容器/inject/可逆副作用开箱即得 | 自研微型内核 ~150 行（学习更深但重造已验证轮子）；简单 EventBus（无依赖注入、无热插拔） |
| D4 | Cordis 自 P1 引入而非 P3 重构 | 避免伤筋动骨的重构；P1 即按服务骨架搭建，后续零迁移成本 | 先裸写后重构（重构代价大） |
| D5 | Electron 作为桌面壳 | TS 全栈统一；main 进程原生拥有 fs/shell 直接跑 core | Tauri（core 是 TS，必须拆成 Node sidecar 进程，凭空多一层 IPC） |
| D6 | 桌面壳先行，编排后置 | 用户核心诉求为桌面端；编排在真实 GUI 中才呈现看板价值 | 多 agent 编排先行（逻辑完整再上 UI，周期长见效慢） |
| D7 | 权限 = `tools/pre-execute` 瀑布钩子链 | 拦截点可插拔，MCP/hooks 免费获得挂载位置 | 在 loop 里硬编码 if-check（不可扩展） |
| D8 | 会话日志单一真相源自 P1 开始 | resume/fork/replay/UI 全部由同一流派生；事后补持久化代价极大 | 内存 messages 数组起步（需二次重构） |
| D9 | grep 用纯 Node 实现 | MVP 零外部依赖，Windows 友好 | 依赖 ripgrep 二进制（性能更优，列为 P6 可选加速项） |

### 4.3 可测试性与 mock provider

agent 系统的测试难点在于 LLM 行为不确定、工具链长、端到端依赖真实网络。测试分层：

| 层 | 范围 | 关键手段 |
|---|---|---|
| 单元 | 工具实现、权限钩子、投影/合并逻辑 | 真实对象 + 内存 fixtures |
| 集成 | loop 驱动一次 turn、工具调用闭环 | **mock LLM provider**（回放预录的 `StreamChunk` 序列，不触网、确定性、廉价） |
| 场景 | 给定输入序列，断言 `SessionEvent` 完整序列 | 录制/回放 fixture，校验日志不变量 |

**mock LLM provider 列为 P1 交付物**：它自身即一个 `ctx.llm` 适配器插件（契合 seam），后续所有集成/场景测试均以其为基座，避免对真实网关的依赖。

---

## 5. 核心概念与领域模型

### 5.1 服务骨架（ctx.* 键位规划）

每个服务占据稳定的 `ctx.<key>` 键位，插件通过 `inject` 声明依赖而非硬编码 import（借鉴 dsh）：

| ctx 键 | 职责 | 提供者 |
|---|---|---|
| `ctx.sessions` | 仅追加 SessionEvent 日志、内存 store、`deriveMessages()` 投影、fork/resume | core/services/session |
| `ctx.systemPrompt` | 提示词片段注册表 + 工具 schema 组装 | core/plugins/system-prompt |
| `ctx.tools` | 工具注册表 + guarded 执行管线（pre-execute/post-execute 钩子） | core/services/tools |
| `ctx.llm` | provider 适配器注册 seam + 统一流式词汇 | core/services/llm |
| `ctx.agents` | Agent 接口、活跃注册表、`agent/*` 事件 | core/services/agent |
| `ctx.agentLoop` | 默认循环驱动器（Agent 接口的默认实现，可替换） | core/services/loop |
| `ctx.config` | 配置加载与分层合并 | core/plugins/config |
| `ctx.permissions` | 权限策略查询 + always 记忆存取 | core/plugins/permissions |

规则：
- 消费方只依赖服务键与服务契约，永不 import 具体实现包。
- 服务提供方可替换（seam）：例如把 `ctx.llm` 后端换掉时，`agentLoop` 等消费方零改动。

**系统提示词骨架（system-prompt 插件负责组装，P1 实现据此不遗漏段落）**：
```
系统提示词 =
  + 身份声明（角色 / 能力边界 / 不可为）
  + 环境信息（cwd、OS、当前时间、可用工具清单）
  + 工具使用约定（何时调用、参数填写规范、结果解读）
  + 用户自定义指令（遵循 AGENTS.md 开放约定：零配置自动发现全局 `~/.heluo-code/AGENTS.md` 与项目根 `AGENTS.md`，二者拼接进提示词；`rules` 配置字段为附加/覆盖路径；单文件上限 32 KiB）
  + 插件贡献的提示词片段（按注册序拼接）
```
各段为独立注册项，拼接顺序稳定（保 prompt cache，见 R4）；动态内容（当前时间等环境信息）按 **turn 计算一次、turn 内各 step 复用**，避免 step 间 system 前缀变化击穿前缀缓存。

### 5.2 会话日志（单一真相源）

**不变量（运行时断言强制）**：凡进入模型请求的信息，必须能从会话日志重建——「Model-visible means logged」。

```ts
interface SessionEventMap {
  // —— 用户域 ——
  'user/message':      { text: string }
  // —— 模型域（原始流保真）——
  'reasoning/chunk':   { stepId: string; delta: string }
  'assistant/chunk':   { stepId: string; delta: string }   // 原始流式块，回放/UI 保真
  'assistant/message': { stepId: string; content: string } // 落定的完整消息
  // —— 工具域 ——
  'tool/call':         { stepId: string; callId: string; name: string; args: unknown }
  'tool/stream':       { callId: string; delta: string }  // 工具实时输出（如 run_command stdout/stderr），仅推 UI，不投影进模型历史
  'tool/result':       { callId: string; output: string; isError: boolean; durationMs: number }
  // —— 权限域 ——
  'permission/request':  { id: string; tool: string; argsSummary: string }
  'permission/response': { id: string; decision: 'allow' | 'deny' | 'always' }
  // —— 结构域（turn/step 边界为持久事实）——
  'turn/start': { turnId: string }
  'turn/end':   { turnId: string; stopReason: 'completed'|'interrupted'|'error'; usage?: TokenUsage }
  'step/start': { stepId: string }
  'step/end':   { stepId: string }
  // —— 编排域（P5）——
  'subagent/spawn':    { agentId: string; task: string }
  'subagent/finished': { agentId: string; summary: string }
}
// 每条日志记录自动附加: { id, sessionId, schemaVersion: 1, timestamp, type, properties }
```

派生关系（一份事件流，多处受益）：

| 能力 | 派生方式 |
|---|---|
| 模型历史 | `deriveMessages()` 将日志投影为 OpenAI 格式 messages |
| UI 渲染 | 订阅实时广播的同一事件流（桌面端 EventMsg 即日志事件的转发） |
| resume | 重启后从 JSONL 尾部恢复状态继续 derive |
| fork | 复制日志前缀到新会话文件 |
| Trajectory 审查视图 | 按 type/source 过滤展示（P6） |
| 上下文压缩 | compaction 能力读取旧日志生成摘要事件替换投影区间（P6） |

存储格式 v1：JSONL，每会话一文件，位于 `~/.heluo-code/sessions/<id>.jsonl`。**P6-0-pre 已落地**（2026-08-30）：`sessions.create` 持有 fd 同步追加写；`resume(sessionId, cwd)` 逐行加载（坏行/半截尾行跳过 + warn、schemaVersion 不匹配拒绝、未知类型跳过）；resume 的 UI 入口与会话标题属 P6-1。

**会话生命周期（v1）**：不做自动清理，文件只增不减；内存中的事件数组与文件同源、同样只增不减（单会话万条事件量级的内存开销可接受）；`~/.heluo-code/sessions/` 长期积累由用户手动管理。归档/过期策略（如 90 天无访问压缩归档）列为 P6 评估项。

**投影性能（实现约束）**：`deriveMessages()` 允许增量投影——缓存上一次投影结果，仅处理自该点以来的新增事件，不要求每次 step 全量重建。投影函数须为纯函数，便于重放与测试。

**最小上下文窗口管理（v1 起生效，compaction 为其增强）**：v1 不做智能压缩，但必须防止窗口溢出崩溃。策略：
- 维护每会话的估算 token 数：**以字符启发式估算为主**（CJK 约 3.5 字符/token、EN 约 4 字符/token），`usage` 返回数据仅用于周期性校准启发式系数，不实时依赖（因为 `deriveMessages()` 在发送请求前就需要决定截断，而 `usage` 要等响应后才返回，存在时序 gap）；
- 设定软上限 = 模型上下文窗口 × 0.9（窗口值由 provider 声明 `contextWindow`，未知时取保守默认 32K）；
- 超出软上限时：保留系统提示词 + 最近 K 条消息（K 可配置，默认 20），更早消息整体尾部截断，并在剩余消息前插入一条 `system` 标注 `[history trimmed: 上下文超限，较早的 N 条消息已被移除]`——标注**进入模型请求**（让模型感知裁剪），被截断的原始消息不进入；
- 若仍超上限（单条消息过大）：对该条消息按字符上限（softCap × 3.5，覆盖 CJK 3.5 字符/token 比率）截断内容并附 `…[截断]` 标记；「截断后仍拒绝开始该 step」的兜底策略列为后续评估项，v1 不实现；
- 智能 compaction（摘要替换）作为 P6 可替换能力，不阻塞 v1。

### 5.3 Turn / Step 语义（借鉴 codex+dsh）

- **turn**：一次用户输入触发的完整工作单元。打开于首个输入被认领，关闭于无未完成工作时。`turn/*` 事件持久化。
- **step**：一次模型请求 + 其触发的全部工具调用。`step/start` 到 `step/end` 之间包含该次的 chunk/tool 事件。
- 中断（Interrupt）：用户可随时打断；当前工具收到 AbortSignal，turn 以 `stopReason: 'interrupted'` 关闭，日志保留已完成部分。
- 循环安全：单 turn 最大 step 数默认 **40**（可配置），超限强制结束并向模型说明。
- **并发不变量（v1 生效）**：单会话同一时刻仅允许一个活跃 turn（单 turn 串行）。用户在 turn 运行期间提交第二条 `user-turn` Op → **直接拒绝**并提示「会话忙，请先中断当前任务」（v1 取最简实现，不引入排队；用户可用 `interrupt` 随时打断后重新提交）。`interrupt` Op 可随时打断当前 turn。子 agent 与主 agent 可能并发操作同一文件，v1 定义 **last-writer-wins**，不做文件锁（冲突检测列为 P6 评估）。

### 5.4 Agent 与子 agent（P5 生效，接口先行）

> P5a 已实施（2026-08-30）：agents 服务（factory/definition/create/get/list/dispose/onStatusChange + 并发上限默认 4 排队）、spawn_subagent 工具（独立会话 + 工具白名单 + 摘要回传）、Q5 权限继承（子 agent 模式 = 父会话快照，记忆隔离）、内置 explorer 预定义 agent；详设见 [`specs/orchestration.md`](specs/orchestration.md)。

- `AgentDefinition`：声明 id、systemPrompt、工具白名单、模型偏好、权限模式。内置插件可贡献预定义 agent（如后续的 explorer/coder/reviewer 角色）。
- 主 agent 通过 `spawn_subagent` 工具创建子 agent：子 agent 拥有**独立会话日志**与受限工具集，完成后仅将摘要回传主会话（上下文隔离，防污染）。
- 子 agent 创建走 seam：`ctx.agents` 为契约，默认 Provider「新建本进程子 agent」，未来可替换为「委派给外部产品」（dsh 设计预留）。
- 并发度上限默认 4，超出排队。

### 5.5 插件形态

```ts
import type { Context } from '@cordisjs/core'   // 包名 P0 核实

interface DiyAgentPlugin {
  name: string                       // 唯一 id，供 patch/禁用引用
  inject?: string[]                  // 依赖的服务键，就绪后才启动
  apply(ctx: Context, config?: unknown): void | Promise<void>
}
```

- **内置插件**随 core 分发，由 boot profile 按序挂载；
- **外部插件**（P3 起生效）：`config.plugins` 数组声明（仅全局配置，见 §9.1 安全边界），boot 挂载完内置插件后由 plugin-loader 逐个加载：
  - npm 包名（如 `@heluo-code/plugin-web-fetch`，依赖由用户侧安装）或本地路径（`.` 开头或绝对路径，相对项目 cwd 解析，ESM `import()` 加载，取 `mod.default ?? mod`）；
  - 单个插件 import/挂载失败 → `logger.error` 记录并继续其余插件，不中断启动；
  - 插件仅依赖 core 公开导出的契约类型（`Context`/`ToolDefinition`/`ToolContext` 等），不直接依赖 Cordis 或 core 内部模块；
- 所有注册（工具、provider、prompt 片段、事件监听、定时器）必须经由 Cordis effect 完成，卸载时逆序回滚——这是热启停的前提；P3 起外部插件与 permissions 等内置插件的钩子均以 `ctx.effect` 包裹注册，dispose 后无残留（有自动化断言）；
- MCP 工具（P6）：转换为与内置工具完全相同的 `ToolDefinition` 后进入 `ctx.tools`，对模型透明（opencode 同构化思路）。

### 5.6 错误处理策略

覆盖 §3.3 正常路径之外的异常路径，保证日志一致性与可恢复性。

- **LLM 层容错**：`ctx.llm.stream()` 遇超时 / 429 / 5xx 时，由 adapter 内部按策略重试——默认最多 3 次、指数退避（1s→2s→4s）、带 `signal` 可中断；可配置「降级 provider」：主 provider 连续失败后切换至备用 provider 继续该 step；所有重试/降级动作写入 core 日志（§5.7）但不作为模型可见事件。
- **turn 级错误闭合**：任何不可恢复错误（超限、降级仍失败、致命配置错误）以 `turn/end` 携带 `stopReason:'error'` 闭合，并附错误摘要；**绝不遗留半开的 turn**，日志状态机保持自洽。
- **工具层幂等与崩溃**：工具实现应尽量幂等；`run_command` 进程崩溃时由执行器清理进程树并写入 `tool/result`（`isError:true`）。若 core 进程在工具执行中途被强杀，重启后从 JSONL 尾部恢复，未闭合的 `step/start` 视为中断（不投影进历史）。
- **流式中断回滚**：网络断流导致 `assistant/chunk` 只写了半截时，该 step 不写入 `assistant/message` 落定事件；resume/重投影时仅以完整事件为准，半截 chunk 被丢弃。

### 5.7 可观测性

agent 系统调试难度高（模型不确定 + 工具链长），需独立的运行态日志（区别于会话日志）。

- **core 日志**：内置分级 logger（`core/logger`，不引第三方依赖），级别 debug/info/warn/error，经环境变量 `HELUO_CODE_LOG_LEVEL` 过滤；输出到 stderr，不污染 SessionEvent 流。
- **关键指标**：每 turn 耗时、累计 token 消耗、工具调用次数/失败率，至少以 `info` 级结构化日志暴露；CLI/桌面端可展示 token 角标（§10）。
- **会话日志 ≠ 运行日志**：`SessionEvent` 是给模型与 UI 的事实流；core 日志是给开发者的诊断流，二者不混写。

### 5.8 优雅退出（Graceful Shutdown）

覆盖正常退出（关闭窗口 / 收到 SIGINT/SIGTERM）而非错误崩溃的情形。

- 收到退出信号 → 立即对当前活跃 turn 发 `interrupt` → 等待最多 **5 秒**让在途工具收尾（AbortSignal 传播）；
- 超时仍未结束 → 强杀残留进程树（run_command 执行器负责）；
- 退出前写入 `turn/end`（`stopReason:'interrupted'`），保证日志状态自洽、可 resume；
- CLI 的「Ctrl+C 二段式」：第一次中断当前 turn（不退出），第二次才触发上述退出流程；
- 退出过程中新到达的 `user-turn` Op 一律忽略。

---

## 6. 接口规格（草案）→ 详规

> 完整的 TypeScript 类型定义（Tool / LLM seam / Agent / Op / EventMsg）已外置至
> [specs/interfaces.md](specs/interfaces.md)（归属 SPEC.md §6）。

---

## 7. 内置工具集规格 → 详规

> 6 个工具（read_file / write_file / edit_file / list_dir / grep_search / run_command）的参数、行为与截断/编码基线已外置至
> [specs/tools.md](specs/tools.md)（归属 SPEC.md §7）。

---

## 8. 权限系统规格 → 详规

> 双轨模型 / 瀑布钩子链 / 三级模式映射 / always 记忆 / 权限事件闭环已外置至
> [specs/permissions.md](specs/permissions.md)（归属 SPEC.md §8）。

---

## 9. 配置系统规格 → 详规

> 文件布局与优先级 / Schema / 分层合并语义 / 安全边界已外置至
> [specs/config.md](specs/config.md)（归属 SPEC.md §9）。

---

## 10. 客户端规格

> §10.2 Desktop 完整客户端详规（进程模型 / IPC / 功能清单 / 验收对照）已外置至 [specs/desktop.md](specs/desktop.md)；当前保留 CLI 总览于此。

### 10.1 CLI（packages/cli，开发调试器定位）

- bin 名 `heluo-code`；readline REPL：多行输入（空行提交）、流式打印 assistant/chunk、工具调用单行摘要、权限确认 y/n/a(always)、Ctrl+C 二段式中断（先断 turn 再退出）；未配置 `model` 时启动打印配置指引（配置文件路径与 HELUO_CODE_HOME 覆盖说明）。
- 子命令：`dev`（默认 REPL）、`--version`。刻意保持极简（~150 行），不投入 TUI 美化。

### 10.2 Desktop（packages/desktop，P4 起的主交付物）

> 进程模型 / IPC 协议 / 安全基线 / 功能清单 / 验收对照的完整详规见 [specs/desktop.md](specs/desktop.md)。摘要：

```
main 进程：boot(core profile) → 持有唯一 Context → ipcMain 处理 Op → webContents.send 推 EventMsg
preload：contextBridge 暴露白名单 API { submit(op), onEvent(cb), getSnapshot(), pickCwd() }
renderer：React SPA，仅经 preload API 通信，绝不接触 core 内部对象
```

- IPC 协议 = specs/interfaces.md 的 Op/EventMsg（Op 走 `heluo:op` send、EventMsg 走 `heluo:event` send、快照/目录选择走 invoke）；EventMsg 按 sessionId 分发；renderer 刷新时先快照全量重放会话日志再订阅增量（状态重同步）
- **P4a 已实施（2026-08-29）**：聊天主区流式渲染（纯文本）、权限卡片三态（allow/deny/always + waiting-permission 状态机）、中断按钮、cwd 选择；验收三连（GUI 闭环 / 权限三态 / 中断无残留）由 Playwright Electron e2e 4 用例断言，真测冒烟（DeepSeek 真实模型）通过
- **P4b 已实施（2026-08-29）**：diff 视图（core 结构化 diff + 行级渲染）、reasoning 折叠块、token 角标、工具实时输出流（tool/stream）、设置页（provider/model/API Key 写 credentials.json）、会话侧栏（多会话、会话绑定 cwd、切换保留历史、事件不串）、Ask/Agent/Quest 模式切换（config.update 内存级即时生效）、electron-builder Windows 打包（asar + NSIS，产物自包含冒烟通过）；验收由 vitest 125 + e2e 7 用例断言（详见 specs/desktop.md §10.2.7/10.2.8）
- **P4b 待实施**：diff 视图、reasoning 折叠块、token 角标、设置页、会话侧栏（多会话）、Ask/Agent/Quest 模式切换
- **打包**：electron-builder；Windows 优先（开发环境 win32），mac/linux 目标列 P6

---

## 11. 分阶段实施计划

> 每阶段以「验收标准」为完成定义（DoD）；测试随阶段交付（vitest）。
> **验收纪律（P1 评审后确立）**：每条验收须可自动化断言，禁止仅 happy-path。必须显式覆盖三类路径——① 中断路径（`interrupt`/AbortSignal，含权限等待中、工具执行中）；② 边界路径（绝对路径越界、超长单消息、空输出步骤、未配置项）；③ 不变量断言（注入回灌、权限记忆跨步、上下文裁剪下限、工具列表稳定排序）。
> 详细接口/工具/权限/配置见 `specs/` 下对应详规。

### P0 脚手架
- workspace 两包骨架（core + cli；desktop 包骨架推迟至 P4）、TS(strict)+ESM+vitest 就绪
- 接入 Cordis：核实 `@cordisjs/core` 最新包名/版本/Node20 ESM 兼容，锁定版本；跑通最小 Context 挂载示例
- 配置加载插件（见 [specs/config.md](specs/config.md) 最小版）与 boot(profile) 入口
- **验收**：`pnpm dev` 启动空 REPL；`pnpm test` 绿；`@cordisjs/core` 版本已锁定且 core 内对 Cordis 类型做薄封装（R1）；`boot(profile, overrides?)` 两参数签名与各插件 `inject` 声明齐备（服务跨插件可见性已验证）

### P1 最小 agent loop ⭐（核心里程碑）
- 范围：四个核心服务（session/llm/tools/agentLoop）、read_file+write_file、system-prompt 插件、CLI REPL、错误处理骨架（§5.6）、最小上下文窗口管理（§5.2）
- 接口与类型见 [specs/interfaces.md](specs/interfaces.md)；LLM 归一化见同一文件
- **mock LLM provider**（§4.3）：回放 `StreamChunk` 序列，作为集成/场景测试基座
- **验收①**：CLI 中让 AI 读指定文件并正确总结（多轮对话保持上下文）；未配置 `model` 时启动期有明确 `logger.warn` 而非仅运行期崩溃
- **验收②**：DeepSeek 与 Qwen 各实测一轮 text + tool call 流式往返（R4 冒烟）
- **验收③**：用 mock provider 跑通一次含工具调用的 turn，断言 `SessionEvent` 序列满足不变量（含错误路径单测）
- **验收④（不变量，P1 评审整改，详见 `tmp/plans/p1-fixes.md`）**：以下每条均须有自动化断言，禁止仅 happy-path 覆盖
  - `inject()` 写入内容在下一步模型请求中以 `system` 消息回灌（注入功能真实生效，非死代码）
  - `read_file`/`write_file` 接受绝对路径时若 escape `cwd` 被拒绝（R8 软约束落地）
  - 权限 `ask` 工具在**等待授权中**被 `interrupt`/`AbortSignal` 解除，turn 干净返回 `interrupted`、进程不挂起
  - 上下文裁剪按总 token 超 `softCap` 触发（含单条超长消息），且保留 `keepLast` 下限
  - 仅 `reasoning` 无文本无工具的步骤不产生空 `assistant` 消息污染上下文
  - 工具列表 `tools` 按名称固定排序（R4）

### P2 工具集补全 + 权限系统 ✅（已实施 2026-08-29）
- 补全 6 个工具（[specs/tools.md](specs/tools.md) 全量行为）；`tools/pre-execute` 瀑布链 + permissions 插件（[specs/permissions.md](specs/permissions.md)）
- Windows shell 实测定稿（PowerShell 参数、conda/git-bash 场景）——**Q2 已关闭**，实测结论回写 tools.md §7.6
- 优雅退出（§5.8）：退出流程 + 日志闭合，强中断不留僵尸进程
- 实施期补充：`tool/stream` 事件（命令实时输出）、`post-execute` 钩子（§5.1 声明补齐）、run_command 命令前缀 always 记忆、`permission.questRunCommand` 可配（详见 `tmp/plans/p2-tools-permissions.md` §10 偏差记录）
- **验收**：AI 独立完成「新建脚本→运行→读报错→修复→再运行通过」闭环（自动化场景测试已断言）；全程权限询问/`always` 记忆跨步正确（同 session 内同一工具 `always` 后不再弹确认）；`ask`/`agent`/`quest` 三级语义与 `specs/permissions.md` 模式表一致（Quest 对 `ask` 工具自动放行，Ask/Agent 等价）；强中断/退出（含**权限等待中** Ctrl+C）不留僵尸进程、日志状态自洽可 resume（以上均已有自动化断言）
- **真测冒烟（2026-08-29，DeepSeek V4 Flash `deepseek-v4-flash`）**：CLI 端到端完成同款闭环（写 buggy.js → 运行报 ReferenceError → read_file → edit_file 修复 → 再运行 exit 0），权限链 4 次确认真实走通，turn `completed`（11,009 tokens）。冒烟发现并修复 5 处真实缺陷（见下）
- **冒烟修复记录（真测暴露，mock 无法覆盖）**：
  1. **AI SDK v7 `instructions` 适配**（P1 潜伏）：v7 不允许 messages 含 `role:'system'`，`streamText` 直接抛 InvalidPromptError；适配器改为提取 system 合并为 `instructions` 选项传递（`plugins/llm-openai-compatible`）。P1 验收②宣称的双网关实测实际未真正执行过——mock 基座绕过 AI SDK，此缺陷被真测首轮暴露
  2. **permissions 竞态**（P1 潜伏）：`permission/request` 广播发生在 `pending` 注册之前，同步响应的消费者（事件订阅回调直接 `respond`）静默丢响应导致权限挂起；改为先注册 pending 再广播（有回归测试）
  3. **CLI 管道 EOF 即退出**：输入流关闭时立即 `unsubscribe + shutdown`，打断进行中 turn；改为等待 `currentTurn` 收尾后再卸载（附 pending 权限 deny 兜底）
  4. **CLI `unsubscribe` 时机**：close 后立即退订导致 turn 后续事件（含 turn/end）不显示；移至 turn 收尾后
  5. **CLI `rl.prompt()` 在关闭后抛 ERR_USE_AFTER_CLOSE**：finally 收尾加保护
  另：CLI 新增 `--yes` 自动放行模式（冒烟/CI 用，权限链真实走通仅决策自动 allow）
- **评审整改（2026-08-29，P2 代码评审后）**：
  6. **grep_search gitignore 跨目录泄漏**：`ignorePatterns` 只增不减，子目录规则错误波及兄弟/父层文件；改为目录栈（try/finally 恢复父级栈），gitignore 语义正确化（父级生效、同级互不影响）+ 回归测试
  7. **run_command taskkill 失败挂起**：kill 后 `close` 若永不触发则工具永久挂起（连带 shutdown 5s 等待失效）；加 kill 后 1.5s 强制收尾兜底
  8. 小项：`interruptAll()` 返回 void（返回值无人消费）；tools.md timeout_ms「硬上限 900000」口径对齐实现（上限 = 配置值）；测试 `boot(... as never)` 掩盖清理（8 处，改类型化 overrides）

### P3 插件生态化 ✅（已实施 2026-08-29）
- 外部插件加载（npm 包名/本地路径，插件形态见 §5.5）；示范插件 `plugin-web-fetch` 按 seam 三角色组织
- provider 注册制完善：新增 provider 零核心改动
- **验收**：不改 core 一行代码接入 web-fetch 插件并被模型调用；插件卸载（dispose）无残留监听（waterfall 钩子、事件订阅全部反注册）；外部插件与内置插件在 `tools/pre-execute` 链路上共存不互相覆盖（§8.2）
- **实施记录（2026-08-29）**：
  - core 新增 `plugins/plugin-loader`（§5.5 外部加载语义：npm 包名/本地路径、失败不中断、effect 包裹注册）；boot 内置挂载完成后加载外部插件
  - 示范插件 `packages/plugin-web-fetch`（`@heluo-code/plugin-web-fetch`）：`web_fetch` 工具（仅 http/https、HTML 剥离、50K 截断、15s 超时、`permission: 'allow'`）；仅依赖 core 公开契约类型
  - core 契约导出补齐：`ToolDefinition/ToolContext/ToolOutcome/SessionHandle`（外部插件即 seam 三角色的「契约」消费方）
  - permissions 插件 pre-execute 钩子补包 `ctx.effect`（P2 遗漏，热卸载卫生）；根 typecheck 覆盖新包
  - 测试 89 全绿（新增 12 条：验收①—⑤ + 失败不崩溃 + 插件形态直挂 + web_fetch 行为 5 条），详见 `tmp/plans/p3-plugins.md`
- **偏差记录**：tools-fs / tools-shell / system-prompt 等内置插件注册仍为直接调用（assume 应用常驻），未全部改接 effect——热启停内置插件不在 P3 范围，P5（子 agent 生命周期）前评估统一；`plugins` 暂不支持给外部插件传配置（`{ name, config }` 对象形式），需要时再扩

### P4 Electron 桌面壳（P4 ✅ 已实施）

> 客户端详规已外置至 [specs/desktop.md](specs/desktop.md)（§10.2 落地版：进程模型/IPC/安全基线/验收对照）。

**P4a 最小可用 GUI ✅（已实施 2026-08-29）**
- main/preload/renderer 三层（electron-vite 构建，§10.2 进程模型与安全基线：contextIsolation + preload 白名单 + CSP；preload 为 ESM 产物故 `sandbox: false`，隔离由 contextIsolation + 白名单承担）
- Op/EventMsg 协议落地（channel 常量与类型在 `src/shared/ipc.ts`）；renderer 刷新状态重同步（快照全量重放 + 增量订阅，快照携带 sessionId/cwd）
- 聊天主区流式渲染（纯文本）、工具卡片（running/done/error）、权限卡片三态（allow/deny/always + waiting-permission 状态机）、中断按钮、cwd 选择与切换（pickCwd 重建会话）
- 退出：window-all-closed → bridge.dispose()（监听/订阅移除）→ app.shutdown()（§5.8）
- core 补充两处契约导出：`SessionStore`（类型）与 `registerMockStepScript`（P3 遗漏，外部消费方需要）
- **验收（全部自动化断言）**：① e2e 闭环——mock 闭环脚本 + 4 次权限卡片 allow，断言工具卡片序列与磁盘文件修复结果；② 权限三态——always 记忆/allow 不记忆/deny 拒绝（卡片计数 + 失败态断言）；③ 中断——权限等待中停止、工具执行中停止均 turn interrupted、卡片消失、可再输入；e2e 4 用例全绿（Playwright `_electron`，mock provider 不触网，脚本复用 P2 场景闭环结构）
- **测试**：desktop 包 13 条单测（renderer reducer 7 + main bridge 6）+ e2e 4 用例；vitest 全仓 102 全绿
- **真测冒烟（2026-08-29，DeepSeek V4 Flash）**：GUI 真实模型完成「写 script.js → 运行 → 输出 Hello, heluo!」，工具序列 list_dir→write_file→run_command，权限卡片 2 次确认真实走通，turn completed（151 事件全程流转）
- **偏差记录**：① 初始 cwd 若仅靠事件广播存在竞态（renderer 订阅晚于 main 广播），快照并入 cwd 字段解决；② 会话 cwd 曾误用 process.cwd()（Electron 启动目录），改为显式传入解析后的工作目录；③ mock step 脚本按会话内 tool 消息总数索引、跨 turn 累计——e2e 中断用例第二次提交按 mock 语义断言 turn 正常完成而非再次弹卡；④ vitest 4 已弃用 workspace 文件，迁移至 root `vitest.config.ts` 的 `test.projects`（desktop 以配置文件引用限定 `src/**/*.test.ts`，避免捡起 Playwright spec）

**P4b 增强体验 ✅（已实施 2026-08-29）**
- diff 视图（core 结构化 diff：`ToolOutcome.diff`/`tool/result.diff`，write/edit 产出 before/after，模型摘要文本不变；renderer DiffView 行级渲染无第三方库）
- reasoning 折叠块（`reasoning/chunk` 按 stepId 累积，挂对应消息前默认收起）、token 角标（`turn/end.usage`）、工具卡片实时输出流（`tool/stream` 累积，result 为准）
- 设置页（provider/model 经 config-set 更新；API Key 经 credentials-set 交 main 写 `~/.heluo-code/credentials.json` 0600——renderer 不持有 key）；**core 补齐凭据回退读取**（`loadApiKey`：apiKeyEnv env > credentials.json，闭合 config.md 声明与实现缺口）
- 会话侧栏（多会话）：bridge 单会话 → Map + active 切换；会话绑定 cwd、切换保留历史；事件仅转发 active 会话（切换不串事件）；快照携带 sessions 列表
- Ask/Agent/Quest 模式切换：core `config.update`（内存级，非法 patch 拒绝）+ permissions 实时读 mode——**即时生效、不追溯**（specs/permissions.md §8.3）
- electron-builder Windows 打包：asar + NSIS（appId com.heluo.code）；core 已 bundle 进 main 产物（externalize 排除），运行时依赖（ai/@cordisjs/core/zod 等）收集进 asar；`pnpm --filter @heluo-code/desktop package` 产出 setup.exe，win-unpacked 冒烟通过（Playwright 启动完整 turn）
- **验收（全部自动化断言）**：vitest 125 全绿（新增 23 条：reducer reasoning/token/stream/diff、diffLines 算法、config.update 即时生效、loadApiKey 回退链、bridge 多会话/配置/凭据）+ e2e 7 用例（新增 diff 展示、模式切换即时生效、多会话切换不串事件）+ typecheck 全绿 + 打包产物冒烟
- **偏差记录**：① e2e 新增脚本（simple/diff/mode）沿用 mock 机制，edit_file 脚本需先 read（editRequiresRead 软约束在 mock 场景同样生效）；② 模式切换按钮不再随 turn busy 禁用（等待授权中切换正是「即时生效」验收场景）；③ `release/` 打包产物加入 .gitignore；④ Windows Defender 对仓库内 `release/` 实时扫描可能引发 EBUSY（打包偶发失败），输出到系统 temp 目录可规避——本机开发已知环境问题，非工程缺陷

### P5 多 agent 编排
- **P5a 已实施**（2026-08-30）：agents 服务（setFactory/registerDefinition/create/get/list/dispose/onStatusChange，默认 factory「本进程子 agent」）；AgentDefinition（systemPrompt/工具白名单/模型偏好/权限模式）+ 内置 explorer 预定义 agent；spawn_subagent 工具（独立会话 + 白名单拒绝 + 摘要回传，主会话落 subagent/spawn|finished 编排事件）；并发上限默认 4 FIFO 排队（`config.agents.maxConcurrency`），排队中可 interrupt；Q5 权限继承（子 agent 模式 = spawn 时父会话快照，permissions 按 session 覆盖表，always 记忆天然按会话隔离）；父 turn 中断级联；详见 specs/orchestration.md
- **验收（P5a 全部自动化断言）**：vitest 137 全绿（新增 12 条：并行派发 2 子 agent 汇总+上下文隔离、并发并行/排队/排队取消、Q5 继承+记忆隔离、白名单拒绝、中断级联、dispose 无残留、参数校验、评审整改：sessionMode 清理 + send 窗口期缓冲）+ typecheck 全绿
- **P5b 已实施**（2026-08-30）：看板 UI——ipc 数据面（EventMsg `agents-status` 全量推送 / Op `agent-interrupt` / Snapshot 携带 agents）+ bridge 订阅 onStatusChange 转发与中断 Op + AgentBoard 组件（任务/definitionId/状态四态徽章/摘要/等待授权 allow|deny|always 按钮/中断按钮）+ 子 agent 权限授权闭环（AgentHandle.pendingPermission，复用 permission-decision Op）；vitest 140 全绿（bridge 新增 3 条）+ e2e 9 用例全绿（新增看板授权闭环/卡片中断 2 用例）+ typecheck 全绿 + 真测冒烟通过（DeepSeek 真实模型并行派发 2 explorer 子代理汇总，12,068 tokens）
- 编排详设已外置至 `specs/orchestration.md`（含看板 UI 契约）
- **验收（全量）**：主 agent 将探索类任务并行派发给 ≥2 个子 agent 并正确汇总结论（P5a ✓）；看板实时反映状态流转（P5b ✓）；子 agent 与主 agent 并发操作同文件时取 last-writer-wins（§5.3），不出现跨会话上下文污染（P5a ✓）；父 Quest 时子 agent 权限继承规则明确（Q5 已关闭：快照继承 + 记忆隔离）

### P6 产品化（持续迭代池，按优先级排序）
0. **进程级沙箱（安全强制项）**：
   - **P6-0-pre 已实施**（2026-08-30）：JSONL 会话持久化落地（§5.2 缺口闭合，见 specs/sandbox.md §4）
   - **P6-0a 已实施**（2026-08-30）：写限制双模式——`restricted-write`（`WRITE_RESTRICTED` 受限令牌 + workspace/temp 派生 SID + ACE 种/撤 + `CreateProcessAsUserW` + KILL_ON_JOB_CLOSE job，**普通用户实测可用**——CreateProcessAsUserW 对「调用者自身受限 token」有特权豁免）+ `job`（无特权保底：JOB_LIST 属性进程树必杀）；`ctx.sandbox` seam + runner.mjs + fail-closed（127 + `sandbox-run:` 前缀）+ 配置 `sandbox.mode`/`writableRoots`；**安全验收**：写 cwd 外被 OS 拒绝 ✓、破坏性命令权限 ask 把关 ✓、进程树必杀 ✓、fail-closed ✓（vitest 156 全绿 + e2e 9 用例全绿 + typecheck 全绿；实测结论与边界披露见 specs/sandbox.md）
   - **P6-0b 进行中**：网络隔离——专用沙箱用户 + 防火墙出站规则（一次性管理员 setup `heluo-code sandbox:setup`）+ elevated helper（named pipe → CreateProcessAsUserW 沙箱用户），`isolated` 模式接入
   - **P6-0c**：Online/Offline 双轨（联网命令经授权走 Online 用户）、桌面设置页沙箱状态展示
1. resume/fork/replay（基于日志派生，预期低成本）+ 会话标题生成
2. 上下文压缩：compaction 作为可替换能力（接口 + 朴素摘要默认实现），防「摘要的摘要」递归劣化
3. MCP 接入（stdio transport 优先，工具同构转换）
4. shell 环境快照（会话启动抓取 PATH/alias/env，解决执行环境不一致）
5. Trajectory 审查视图、命令级白名单细化、ripgrep 加速、成本统计面板
6. macOS/Linux 打包
7. AGENTS.md 完整层级发现（子目录 git根→cwd 逐级拼接、`.heluo-code/AGENTS.override.md` 逃生口、可配 fallback 文件名），v1 仅做零配置自动发现项目根 + 全局层（§5.1）
8. web_fetch 的 SSRF 防护（内网/环回地址阻断或显式授权；当前与 read_file 同款信任模型：`permission: 'allow'` + 任意 http/https URL，由 P6-0 沙箱兜底）

---

## 12. 成熟项目借鉴对照表

| 来源 | 借鉴点 | 落位于本文 | 规避的坑 / 反面教训 |
|---|---|---|---|
| **codex** | Submission/Event 双队列解耦渲染与 loop | §6 Op/EventMsg、§10.2 | 双队列本身是解耦关键，别回到同步调用 UI |
| codex | 沙箱（能不能）与审批（问不问）分离；Restricted Token/Job Object/ACL 的 Windows 实现 | §8.1、§11 P6-0 | 自研若不做 OS 沙箱（R8），仅靠软约束有越权风险 |
| codex | 上下文压缩及「摘要的摘要」教训 | §11 P6-2、§5.2 | 压缩递归劣化 → 用模板法避免摘要套摘要 |
| codex | prompt cache 教训：工具列表固定排序 | §6 ModelRequest.tools 注释、R4 | 工具列表不稳定直接打爆缓存、烧钱 |
| codex | reasoning_content 在部分网关被吞 | §13 R2 | provider 归一化需显式携带厂商扩展字段 |
| **Claude Code** | 工具粒度与语义（带行号 Read/唯一匹配 Edit/Grep-Glob 分离） | §7 | — |
| **opencode** | 无头 server + 多薄客户端范式 | §3.1 | 早期 session 状态管理混乱 → 用事件总线单一真相源（§5.2）规避 |
| opencode | AI SDK 做 provider 抽象层 | D2 | — |
| opencode | 事件总线驱动 UI（从不轮询） | §3.3、§5.2 | — |
| opencode | MCP 工具与内置工具同构化 | §5.5、§11 P6-3 | — |
| opencode | 配置 JSONC + env 占位符 | §9.1 | — |
| **DeepSeek Harness** | 万物皆插件：连 loop 都是可替换插件 | §5.1 ctx.agentLoop | 不为插件而插件（R6） |
| dsh | Cordis 五机制：服务容器/inject/类型化事件/可逆副作用/seam | §3.1、§5.1、§5.5 | O(n²) 抽象膨胀 → 单候选实现时不拆 seam |
| dsh | 会话日志单一真相源 + Model-visible means logged 断言 | §5.2 | 缺 schemaVersion 难迁移 → 每条事件带版本（§5.2） |
| dsh | turn/step 事件词汇、waterfall 拦截点 | §5.3、§8.2 | — |
| dsh | seam 三角色分包（契约/实现/消费） | §5.4、§11 P3/P5 | 过早拆包增加样板，按 D6 规则克制 |
| dsh | agent.inject() 运行时注入 | §6 ToolContext.inject | — |
| **Qoder/QoderWork** | Ask/Agent/Quest 三级自主性 | §8.3、§10.2 | 放权需边界，Quest 仍受 cwd 约束（§8.1） |
| Qoder | Quest 任务看板/状态标签/产物审查 | §11 P5 | — |
| Qoder | Shell 快照解决环境一致性 | §11 P6-4 | 不做快照则命令环境与用户终端不一致（R3） |

---

## 13. 风险与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | Cordis 包生态仍在演进（dsh 尚处 preview，上游同样迭代） | API 变动破坏升级 | P0 锁定版本；core 内做一层薄封装隔离 Cordis 类型外泄 |
| R2 | AI SDK 对个别国产网关的兼容缺口（reasoning 字段、参数差异） | 特定 provider 异常 | P1 双网关冒烟（验收②）；llm seam 允许按 provider 写归一化补丁插件，极端情况替换整个 adapter |
| R3 | Windows shell 执行差异（PowerShell/cmd/conda/git-bash 的 PATH 与引号规则） | run_command 结果不可靠 | P2 实测定稿执行器参数；P6 环境快照兜底 |
| R4 | 工具列表顺序不稳定打爆 prompt cache（codex 已踩坑） | 成本上升、变慢 | ModelRequest.tools 强制按名称排序；插件注册不改变呈现顺序 |
| R5 | Electron 安全面 | 恶意网页内容经模型进入 renderer？ | contextIsolation + preload 白名单；renderer 不持 apiKey；模型输出按纯文本渲染（Markdown 白名单，禁 raw HTML/script） |
| R6 | 插件化过度抽象导致复杂度膨胀（dsh 公开批评点，O(n²) 交互成本） | 维护困难、理解门槛高 | 遵循 dsh 自己的规则：「只有一个可能的 provider 时不拆分」；每引入一个 seam 必须同时有两个候选实现动机 |
| R7 | 长 turn 死循环/费用失控 | 体验差、烧钱 | maxStepsPerTurn=40 硬顶；usage 逐 turn 入日志并在 UI 展示 |
| R8 | `run_command` 文件/网络越权、仓库内 prompt injection 诱导执行破坏性命令 | 数据丢失、隐私外泄 | **P6-0a 已落地写限制**（WRITE_RESTRICTED 双通过写检查，普通用户可用）与进程树必杀（KILL_ON_JOB_CLOSE）；网络隔离 P6-0b（专用沙箱用户 + 防火墙，需一次性管理员 setup）；v1 期权限 ask + cwd 软约束继续兜底（详见 specs/sandbox.md） |

---

## 14. 未决问题（实施期逐项关闭）

| # | 问题 | 计划关闭时点 |
|---|---|---|
| Q1 | `@cordisjs/core` 确切包名、最新版本、Node≥20 ESM 兼容性、与 dsh vendor 版本的 API 差异 | P0（已锁定 4.0.0-beta.5，beta） |
| Q2 | run_command 最终执行器选型（PowerShell 启动开销 vs cmd 兼容性；是否探测 git-bash） | 已关闭（P2 实施：`powershell.exe -NoProfile -NonInteractive -Command` + UTF-8 前缀 + taskkill 进程树，实测结论见 tools.md §7.6） |
| Q3 | 会话存储 JSONL 是否满足 fork/replay 性能（万条事件级），何时迁 SQLite | P6 前 |
| Q4 | reasoning 内容（DeepSeek-R 类）进日志的体积策略（全量保真 vs 采样） | P6 |
| Q5 | 子 agent 的权限模式继承规则（父 Quest 时子 agent 默认权限） | 已关闭（P5a：spawn 时父会话模式快照 + 按 session 覆盖 + always 记忆隔离，见 specs/orchestration.md §5） |
| Q6 | token 计数在非 OpenAI 网关上的口径统一（AI SDK usage 直传 vs 本地估算） | P6 |
| Q7 | AI SDK 版本：规格写 v5，P0 核实时 npm latest 为 v7.0.83，P1 已确认采用 v7（`ai@^7` + `@ai-sdk/openai-compatible@^3`） | 已关闭（P1 实施） |
| Q8 | 普通用户（非管理员）能否创建 WRITE_RESTRICTED 受限子进程（CreateProcessAsUserW 特权豁免的真实范围） | 已关闭（P6-0a 实测：CreateProcessAsUserW + 调用者自身受限 token 在普通用户可用；CreateProcessW + PROC_THREAD_ATTRIBUTE_TOKEN 不可用；AppContainer 对普通 CLI 工具 0xC0000142 不可行。见 specs/sandbox.md §3） |


