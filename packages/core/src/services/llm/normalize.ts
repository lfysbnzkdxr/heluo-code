import type { TextStreamPart, ToolSet } from 'ai'
import type { TokenUsage } from '../../shared/events'
import type { StreamChunk } from './types'

function mapUsage(usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined): TokenUsage {
  return {
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
  }
}

export async function* normalizeFullStream(
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>,
): AsyncIterable<StreamChunk> {
  try {
    for await (const part of fullStream) {
      switch (part.type) {
        case 'text-delta':
          yield { type: 'text-delta', delta: part.text }
          break
        case 'reasoning-delta':
          yield { type: 'reasoning-delta', delta: part.text }
          break
        case 'tool-call':
          yield {
            type: 'tool-call',
            call: {
              id: part.toolCallId,
              name: part.toolName,
              argsJson: JSON.stringify((part as { input?: unknown }).input ?? {}),
            },
          }
          break
        case 'finish':
          yield { type: 'usage', usage: mapUsage(part.totalUsage as { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined) }
          break
        case 'error':
          yield { type: 'error', error: part.error instanceof Error ? part.error : new Error(String(part.error)) }
          break
        default:
          break
      }
    }
    yield { type: 'done' }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      yield { type: 'done' }
      return
    }
    yield { type: 'error', error: error instanceof Error ? error : new Error(String(error)) }
    yield { type: 'done' }
  }
}
