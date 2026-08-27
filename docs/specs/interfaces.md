# SPEC 详规：接口规格（interfaces）

> 归属：docs/SPEC.md §6
> 本文件是主契约的按域详规；交叉契约（架构/决策/服务骨架/领域模型）以主文档 `../SPEC.md` 为准。
> 返回：../SPEC.md

---

## 6. 接口规格（草案）

> 以下为 TypeScript 类型草案，编码时可微调；字段语义与不变量以本文为准。

```ts
// ================= Tool =================
interface ToolDefinition {
  name: string                       // snake_case，全局唯一
  description: string                // 给模型看的说明
  parameters: JsonSchema             // 输入 schema
  permission: PermissionPolicy       // 见 §8
  execute(args: unknown, tctx: ToolContext): Promise<ToolResult>
}

interface ToolContext {
  cwd: string
  signal: AbortSignal                // 中断传播
  session: SessionHandle
  inject(text: string): void         // 向下一获准请求注入上下文（借鉴 dsh agent.inject）
}

type ToolResult =
  | { ok: true; outputForModel: string }        // 截断后的文本，直接进日志
  | { ok: false; errorForModel: string }

// ================= LLM seam =================
interface LlmService {
  registerAdapter(id: string, factory: AdapterFactory): () => void   // effect-scoped，返回 disposer
  stream(req: ModelRequest): AsyncIterable<StreamChunk>
}

interface ModelRequest {
  adapterId: string                  // e.g. "deepseek"
  model: string                      // e.g. "deepseek-chat"
  messages: ModelMessage[]           // 由 deriveMessages 投影而来
  tools: ToolSchema[]                // 固定排序（保 prompt cache，见 R4）
  signal: AbortSignal
}

type StreamChunk =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call'; call: { id: string; name: string; argsJson: string } }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'error'; error: Error }
  | { type: 'done' }

// ================= Agent =================
interface AgentService {
  setFactory(f: AgentFactory): () => void
  create(opts: CreateAgentOptions): Promise<AgentHandle>
  get(id: string): AgentHandle
  list(): AgentHandle[]
}

interface CreateAgentOptions {
  definitionId?: string              // 引用预定义 agent；否则 inline 配置
  task: string
  parentSessionId?: string           // 子 agent 场景
}

interface AgentHandle {
  id: string
  status: 'idle' | 'running' | 'waiting-permission' | 'done' | 'failed'
  send(text: string): void
  interrupt(): void
  dispose(): Promise<void>
}

// ================= 客户端协议（codex 双队列借鉴）=================
// renderer/CLI → core
type Op =
  | { type: 'create-session' }
  | { type: 'resume-session'; sessionId: string }
  | { type: 'user-turn'; sessionId: string; text: string }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'permission-decision'; requestId: string; decision: 'allow'|'deny'|'always' }
  | { type: 'set-mode'; mode: 'ask' | 'agent' | 'quest' }

// core → renderer/CLI（EventMsg 本质是 SessionEvent 的转发 + 少量运行态）
type EventMsg =
  | { type: 'session-event'; event: SessionEvent }
  | { type: 'agents-status'; agents: Array<{ id: string; status: AgentHandle['status'] }> }
  | { type: 'fatal-error'; message: string }
```
