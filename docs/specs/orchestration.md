# SPEC 详规：多 agent 编排（orchestration）

> 归属：docs/SPEC.md §5.4（P5 生效，接口先行）与 §11 P5
> 本文件是 P5 的编排域详设：AgentDefinition / agents 服务 / spawn_subagent / 并发与排队 / Q5 权限继承 / 看板 UI 契约（P5b）。
> 交叉契约（架构/事件类型/并发不变量）以主文档 `../SPEC.md` 为准。
> 返回：../SPEC.md

---

## 1. 范围与阶段切分

| 阶段 | 范围 | 状态 |
|---|---|---|
| **P5a**（已完成） | agents 服务 + AgentDefinition 注册 + spawn_subagent 工具 + Q5 权限继承 + 编排事件落日志；vitest 137 全绿 | ✅ 2026-08-30 |
| **P5b**（已完成） | 看板 UI：agents-status / agent-interrupt 数据面 + AgentBoard 组件 + 子 agent 权限授权闭环 + e2e；真测冒烟 | ✅ 2026-08-30 |

## 2. AgentDefinition

```ts
interface AgentDefinition {
  id: string                        // 唯一 id，供 spawn_subagent 引用
  systemPrompt: string              // 子 agent 专属 system prompt（覆盖全局 system-prompt 段）
  tools?: string[]                  // 工具白名单；缺省 = 全部内置/已注册工具
  model?: string                    // 模型偏好（"<adapterId>/<modelName>"）；缺省继承父配置
  permissionMode?: 'ask' | 'agent' | 'quest'   // 权限模式覆盖；缺省 = 继承父会话模式快照（Q5）
}
```

- 定义由 agents 服务注册（`registerDefinition`，effect 包裹，dispose 反注册）。
- **内置预定义 agent `explorer`**：探索类任务角色——`tools: ['read_file', 'list_dir', 'grep_search']`，其余字段缺省（继承）。随 core 分发，不占配置。
- 外部插件可通过 agents 服务注册自定义 agent（P3 插件机制同构）。

## 3. agents 服务（core 侧）

```ts
interface AgentService {
  setFactory(f: AgentFactory): () => void      // seam：默认「本进程子 agent」factory；可替换（未来委派外部产品）
  registerDefinition(def: AgentDefinition): () => void
  getDefinition(id: string): AgentDefinition | undefined
  create(opts: CreateAgentOptions): Promise<AgentHandle>
  get(id: string): AgentHandle | undefined
  list(): AgentHandle[]
  dispose(agentId: string): Promise<void>      // 中断 + 注销 + 释放队列位
  onStatusChange(cb: (handle: AgentHandle) => void): () => void
}

interface CreateAgentOptions {
  definitionId?: string            // 引用预定义 agent；否则 inline 配置（见 §3.2）
  task: string
  parentSessionId?: string         // 子 agent 场景：编排主会话 id
  signal?: AbortSignal             // 父 turn 中断级联
}

interface AgentHandle {
  id: string
  definitionId?: string
  task: string
  parentSessionId?: string
  sessionId: string                // 子 agent 独立会话（P5a 为内存 SessionStore，P6 评估持久化）
  status: 'idle' | 'running' | 'waiting-permission' | 'done' | 'failed'
  summary?: string                 // 完成摘要（最后一条非空 assistant/message 内容）
  error?: string                   // failed 原因
  send(text: string): void         // 追加用户消息（v1：子 agent 运行中追加视为注入，不强制另开 turn）
  interrupt(): void
  dispose(): Promise<void>
}
```

### 3.1 并发模型（上限 4 排队）

- `config.agents.maxConcurrency` 默认 **4**（schema 新增）。
- `create()` 立即返回 handle（status `idle`）；running 数 ≥ 上限时进入 **FIFO 等待队列**，有空位自动启动。
- 排队中 `interrupt()` / `dispose()`：从队列移除并标记 `done`（interrupted），不占用位。
- 状态流转广播 `onStatusChange`（P5b 看板数据源之一；desktop bridge 转为 `agents-status` EventMsg，见 interfaces.md）。

### 3.2 默认 factory：本进程子 agent

1. `ctx.sessions.create({ cwd })` → 独立会话（与主会话零共享，防上下文污染）；
2. `ctx.agentLoop.openTurn` 以子会话运行，选项：
   - `systemPrompt` ← definition.systemPrompt（缺省为全局 system prompt）；
   - `toolAllowlist` ← definition.tools（白名单过滤，见 §4.2）；
   - `permissionMode` ← definition.permissionMode ?? **父会话创建时模式快照**（Q5，见 §5）；
   - `signal` ← create 传入的父 turn signal 级联；
3. 子会话 `turn/end` → 摘要：取子会话**最后一条非空 `assistant/message` 的 content** 作为 `summary`（v1 朴素实现：子 agent 的最终结论即摘要；不额外消耗模型轮次生成摘要。**由模型生成结构化摘要列为 P6 评估项**）；
4. 摘要/错误回写主会话日志 + 状态置 `done` / `failed`（`error` 为 turn/end 的 stopReason 或错误消息）。

## 4. spawn_subagent 工具

```ts
// name: 'spawn_subagent'  permission: 'allow'（编排工具本身不弹权限；子 agent 内部工具按权限系统）
parameters: {
  task: string          // 必填：子任务描述（即子会话首条 user/message）
  definitionId?: string // 可选：预定义 agent id；缺省为「通用子代理」（继承全部工具）
}
```

- 执行语义：`agents.create(...)`（parentSessionId = 主会话 id，signal = 主 turn signal）→ **阻塞等待完成** → 返回 `tool/result.output`：
  ```
  [subagent <id> 完成]
  任务: <task>
  状态: done | failed
  摘要: <summary 或 error>
  ```
- **中断级联**：主 turn 被 interrupt（AbortSignal）→ 对在途子 agent `interrupt()`；排队中的 create 移除。
- 主会话日志追加编排域事件（`../SPEC.md §5.2` 预定义）：
  - 创建时 `subagent/spawn`：`{ agentId, task }`
  - 完成时 `subagent/finished`：`{ agentId, summary }`
  - 二者在 `deriveMessages()` 的 default 分支被忽略——**主会话模型历史只见摘要文本，不见子 agent 内部事件**（上下文隔离的核心保证）。
- 并发操作同文件：沿用 §5.3 **last-writer-wins**，不做文件锁（冲突检测列为 P6 评估）。

### 4.1 工具白名单执行语义

- 请求侧：`getSchemaList().filter(t => allowlist.includes(t.name))`，模型只见白名单内工具；
- 执行侧：模型若调用白名单外工具 → 不执行，直接写 `tool/result`（`isError: true`，文案「工具不在该子 agent 可用工具集」），与「未知工具」同级降级。

## 5. Q5 权限继承规则（决策记录）

**决策：子 agent 权限模式 = spawn 时父会话当前模式快照；always 记忆按子会话独立。**

- 实现：permissions 服务新增**按 session 的模式覆盖表**（`setSessionMode(sessionId, mode)` / `getEffectiveMode(sessionId)`）；pre-execute 钩子读 mode 处改为 `getEffectiveMode(tctx.session.id)`——主会话无覆盖 → 回落 `config.permission.mode`（行为不变）；子会话有覆盖 → 用快照。
- **记忆隔离**：permissions 的 always 记忆本就以 `Map<sessionId, …>` 键控（P2 落地），子会话天然独立——子 agent 的 always 授权**不回流**父会话，父会话授权也**不流入**子 agent（防授权扩散）。
- `AgentDefinition.permissionMode` 显式声明时优先于父快照（如 explorer 可按需声明）。
- 变更时机：mode 在子 agent 运行中变更**不影响**该子 agent（快照语义，不追溯）。

## 6. 看板 UI 契约（P5b 落地详设）

### 6.1 数据面（desktop shared/ipc.ts）

```ts
interface AgentInfo {
  id: string
  definitionId?: string
  task: string
  status: AgentStatus              // idle | running | waiting-permission | done | failed
  summary?: string
  error?: string
  pendingPermission?: { id: string; tool: string; argsSummary: string }   // waiting-permission 时的待决授权
}

// EventMsg 新增（全量推送，量小：并发上限 4 + 已完成，与快照重同步口径一致）
{ type: 'agents-status'; agents: AgentInfo[] }
// Op 新增
{ type: 'agent-interrupt'; agentId: string }
// Snapshot 新增
agents: AgentInfo[]
```

### 6.2 core 侧小改：子 agent 权限授权闭环

- `AgentHandle` 增加 `pendingPermission?: { id; tool; argsSummary }`：defaultFactory 订阅子会话事件填充（permission/request）与清除（permission/response）。
- renderer 收到看板卡片上的授权按钮 → 复用现有 `permission-decision` Op（requestId 全局唯一，permissions.respond 无需会话定位）→ 子 agent 权限请求完成闭环。主区 PermissionCard 不受影响（子请求不进入主会话事件流）。

### 6.3 bridge（desktop main/bridge.ts）

- 订阅 `ctx.agents.onStatusChange` → 广播 `agents-status`（全量 `list()` 映射 AgentInfo）。
- `agent-interrupt` Op → `ctx.agents.get(agentId)?.interrupt()`（排队中/在途均生效）。
- 快照重同步携带 `agents`（renderer 刷新后恢复看板）。

### 6.4 renderer（AgentBoard 组件）

- 位置：聊天主区底部面板（`data-testid="agent-board"`），有子 agent 时展示。
- 卡片（`data-testid="agent-card"`）：
  - 首行：任务文本 + definitionId + 状态徽章（running=运行中 / waiting-permission=等待授权 / done=完成 / failed=失败 / idle=排队中）；
  - 摘要/错误文本（done/failed 时）；
  - 等待授权时：allow / deny / always 按钮（`data-testid="agent-perm-<decision>"`）；
  - running/waiting-permission 时：中断按钮（`data-testid="agent-interrupt"`）。
- 状态来源：`agents-status` EventMsg 全量替换本地 state（与快照 `agents` 初始一致），与 session 事件流完全解耦。

### 6.5 验收标准（P5b 全部自动化断言）

1. **vitest（bridge 新增）**：① `agents-status` 转发（create 后收到全量推送，状态流转伴随推送）；② `agent-interrupt` Op 中断在途子 agent（子会话 turn/end=interrupted）；③ 快照携带 agents 列表。
2. **e2e 用例 A「看板授权闭环」**：agent 模式，主 agent `spawn_subagent` 派发写文件子任务 → 看板卡片出现且状态「等待授权」→ 点 allow → 卡片流转「完成」+ 摘要文本可见 + 文件落盘 + 主 turn completed。
3. **e2e 用例 B「看板中断」**：子 agent 挂起在权限请求 → 点卡片中断按钮 → 卡片「完成」（interrupted 摘要）且主 turn 正常 completed。
4. **typecheck 全绿**（desktop node + web）。
5. **真测冒烟（真实模型）** ✅：DeepSeek V4 Flash 真实跑通「并行派发 2 个 explorer 子代理探索代码并汇总」——主 agent 经 spawn_subagent 派发 3 次（子任务 B 首因 cwd 软约束拒绝路径后，主 agent 依据摘要自我修正重派），子代理独立会话 + 摘要回传正常，主 agent 结构化汇总 5 条要点，turn completed（12,068 tokens）。真实行为符合设计（cwd 软约束拒绝 + 摘要闭环推理），未暴露需修复缺陷。

## 7. P5a 验收清单（全部自动化断言）

1. **并行派发**：主 agent 经 stepScripts 连续调用 spawn_subagent ×2（不同 model 名区分脚本），两个子 agent **并行**运行（断言两个子会话 turn 存在交错或至少都完成），主会话 `subagent/finished` 事件与 `tool/result` 摘要各含两子结论——「正确汇总结论」。
2. **上下文隔离**：主会话事件集不含子会话内部事件（tool/call、assistant 等），反之亦然；`deriveMessages(主会话)` 中无子 agent 内部消息。
3. **并发上限排队**：`agents.maxConcurrency = 1` 时第二个 create 保持 `idle`（排队）至第一个完成；排队中 interrupt 可取消。
4. **Q5 权限继承**：父 mode=quest → 子 agent 的 ask 工具免确认；子会话 always 后父会话同工具仍 ask（记忆隔离）；父 mode 快照在子 agent 运行中变更不追溯。
5. **工具白名单**：definition.tools 白名单外工具调用被拒绝（isError），模型历史无越权执行。
6. **中断级联**：主 turn 中断 → 在途子 agent 以 interrupted 闭合（子会话 turn/end 为 interrupted），日志自洽。
7. **dispose 无残留**：agents 服务 dispose 后 list 为空、定义反注册、无队列悬挂。
8. **不变量**：子会话事件满足 turn/step 边界不变量（复用 agentLoop 断言）。

## 8. 偏差与取舍记录

- **摘要为朴素实现**：取最后一条非空 assistant/message，不额外消耗模型轮次；结构化摘要生成（含决策树/成本）列为 P6。
- **子 agent 会话不持久化**：P5a 子会话为内存 SessionStore；主会话编排事件（subagent/spawn|finished）已入主会话日志，可支撑 replay 重建看板；子会话 JSONL 持久化与 resume 一并评估（P6-1）。
- **排队不设 status 位**：排队中 handle.status 为 `idle`（interfaces.md 预定义状态集不含 queued），看板以 idle 展示；如需区分再加状态值（P5b 前评估）。
- **usage 口径**：子 agent 的 token 用量计入子会话 turn/end.usage，主会话 usage 不含子 agent（分开计）；统一口径列 P6（Q6）。
- **send() 语义**：v1 仅作注入上下文（复用 session.inject），不新开 turn；「子 agent 对话式追问」列 P6 评估。会话建立前的窗口期调用不丢失（缓冲至会话建立后注入，评审整改已补测试）。
