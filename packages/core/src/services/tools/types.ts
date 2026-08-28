import type { SessionEvent, SessionEventMap, SessionEventType } from '../../shared/events'

export type JsonSchema = Record<string, unknown>

export type PermissionPolicy = 'allow' | 'ask'

export interface ToolResult {
  ok: true
  outputForModel: string
}

export interface ToolErrorResult {
  ok: false
  errorForModel: string
}

export type ToolOutcome = ToolResult | ToolErrorResult

export interface SessionHandle {
  id: string
  cwd: string
  inject(text: string): void
  takeInject(): string[]
  append<K extends SessionEventType>(type: K, properties: SessionEventMap[K]): SessionEvent
}

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  session: SessionHandle
  inject(text: string): void
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchema
  permission: PermissionPolicy
  execute(args: unknown, tctx: ToolContext): Promise<ToolOutcome>
}
