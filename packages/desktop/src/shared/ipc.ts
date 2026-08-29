import type { AgentStatus, SessionEvent } from '@heluo-code/core'

// renderer → main（fire-and-forget，回执由事件流承载）
export type Op =
  | { type: 'user-turn'; sessionId: string; text: string }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'permission-decision'; requestId: string; decision: 'allow' | 'deny' | 'always' }
  | { type: 'create-session' }
  | { type: 'switch-session'; sessionId: string }
  | { type: 'agent-interrupt'; agentId: string }

export interface SessionInfo {
  id: string
  cwd: string
  active: boolean
}

export interface AgentInfo {
  id: string
  definitionId?: string
  task: string
  status: AgentStatus
  summary?: string
  error?: string
  pendingPermission?: { id: string; tool: string; argsSummary: string }
}

// main → renderer（EventMsg 本质是 SessionEvent 的转发 + 少量运行态，SPEC §10.2）
export type EventMsg =
  | { type: 'session-event'; event: SessionEvent }
  | { type: 'cwd-changed'; cwd: string }
  | { type: 'sessions-changed'; sessions: SessionInfo[] }
  | { type: 'agents-status'; agents: AgentInfo[] }

export interface Snapshot {
  sessionId: string
  cwd: string
  events: SessionEvent[]
  sessions: SessionInfo[]
  agents: AgentInfo[]
}

// 设置页/模式切换数据面（P4b）：配置快照 + 运行时可改项
export type PermissionMode = 'ask' | 'agent' | 'quest'

export interface ProviderOption {
  id: string
  type: string
  baseURL?: string
  models?: string[]
}

export interface ConfigSnapshot {
  model: string
  providers: ProviderOption[]
  permissionMode: PermissionMode
}

// preload 白名单 invoke API（renderer 刷新时全量重放会话日志，§10.2 状态重同步）
export interface PreloadApi {
  submit(op: Op): void
  onEvent(cb: (msg: EventMsg) => void): () => void
  getSnapshot(): Promise<Snapshot>
  pickCwd(): Promise<string | null>
  getConfig(): Promise<ConfigSnapshot>
  setConfig(patch: { model?: string; permissionMode?: PermissionMode }): Promise<void>
  setCredentials(providerId: string, apiKey: string): Promise<void>
}

export const IPC_CHANNEL_OP = 'heluo:op'
export const IPC_CHANNEL_EVENT = 'heluo:event'
export const IPC_CHANNEL_SNAPSHOT = 'heluo:snapshot'
export const IPC_CHANNEL_PICK_CWD = 'heluo:pick-cwd'
export const IPC_CHANNEL_CONFIG_GET = 'heluo:config-get'
export const IPC_CHANNEL_CONFIG_SET = 'heluo:config-set'
export const IPC_CHANNEL_CREDENTIALS_SET = 'heluo:credentials-set'
