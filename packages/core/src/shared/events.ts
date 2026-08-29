export const SESSION_EVENT_SCHEMA_VERSION = 1

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface FileDiff {
  path: string
  before: string
  after: string
}

export interface SessionEventMap {
  'user/message': { text: string }
  'reasoning/chunk': { stepId: string; delta: string }
  'assistant/chunk': { stepId: string; delta: string }
  'assistant/message': { stepId: string; content: string }
  'tool/call': { stepId: string; callId: string; name: string; args: unknown }
  'tool/stream': { callId: string; delta: string }
  'tool/result': { callId: string; output: string; isError: boolean; durationMs: number; diff?: FileDiff }
  'permission/request': { id: string; tool: string; argsSummary: string }
  'permission/response': { id: string; decision: 'allow' | 'deny' | 'always' }
  'turn/start': { turnId: string }
  'turn/end': { turnId: string; stopReason: 'completed' | 'interrupted' | 'error'; usage?: TokenUsage }
  'step/start': { stepId: string }
  'step/end': { stepId: string }
}

export type SessionEventType = keyof SessionEventMap

export type SessionEvent =
  | { [K in keyof SessionEventMap]: {
      id: string
      sessionId: string
      schemaVersion: number
      timestamp: number
      type: K
      properties: SessionEventMap[K]
    } }[keyof SessionEventMap]

export interface SessionEventBase {
  id: string
  sessionId: string
  schemaVersion: number
  timestamp: number
}

export function isSessionEvent(value: unknown): value is SessionEvent {
  return typeof value === 'object' && value !== null && 'type' in value && 'properties' in value
}
