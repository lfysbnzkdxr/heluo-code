import type { ModelMessage } from 'ai'
import type { ProviderConfig } from '../../plugins/config/schema'
import type { TokenUsage } from '../../shared/events'

export type StreamChunk =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call'; call: { id: string; name: string; argsJson: string } }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'error'; error: Error }
  | { type: 'done' }

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ModelRequest {
  adapterId: string
  model: string
  messages: ModelMessage[]
  tools: ToolSchema[]
  signal: AbortSignal
}

export interface AdapterDeps {
  providerConfig?: ProviderConfig
}

export type AdapterFactory = (req: ModelRequest, deps: AdapterDeps) => AsyncIterable<StreamChunk>

export interface LlmService {
  registerAdapter(id: string, factory: AdapterFactory): () => void
  stream(req: ModelRequest): AsyncIterable<StreamChunk>
}
