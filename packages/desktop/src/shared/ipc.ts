import type { SessionEvent } from '@heluo-code/core'

// renderer → main（fire-and-forget，回执由事件流承载）
export type Op =
  | { type: 'user-turn'; sessionId: string; text: string }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'permission-decision'; requestId: string; decision: 'allow' | 'deny' | 'always' }

// main → renderer（EventMsg 本质是 SessionEvent 的转发 + 少量运行态，SPEC §10.2）
export type EventMsg =
  | { type: 'session-event'; event: SessionEvent }
  | { type: 'cwd-changed'; cwd: string }

// preload 白名单 invoke API（renderer 刷新时全量重放会话日志，§10.2 状态重同步）
export interface PreloadApi {
  submit(op: Op): void
  onEvent(cb: (msg: EventMsg) => void): () => void
  getSnapshot(): Promise<{ sessionId: string; cwd: string; events: SessionEvent[] }>
  pickCwd(): Promise<string | null>
}

export const IPC_CHANNEL_OP = 'heluo:op'
export const IPC_CHANNEL_EVENT = 'heluo:event'
export const IPC_CHANNEL_SNAPSHOT = 'heluo:snapshot'
export const IPC_CHANNEL_PICK_CWD = 'heluo:pick-cwd'