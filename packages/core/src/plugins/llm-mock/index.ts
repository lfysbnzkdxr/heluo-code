import type { ModelMessage } from 'ai'
import type { Context } from '@cordisjs/core'
import type { AdapterFactory, StreamChunk } from '../../services/llm/types'

const scripts = new Map<string, StreamChunk[]>()

export function registerMockScript(name: string, chunks: StreamChunk[]): void {
  scripts.set(name, chunks)
}

function hasToolMessage(messages: ModelMessage[]): boolean {
  return messages.some((m) => m.role === 'tool')
}

const factory: AdapterFactory = (req) => {
  const alreadyRanTool = hasToolMessage(req.messages)
  const script = alreadyRanTool
    ? [{ type: 'text-delta', delta: '（基于工具结果得出最终结论）' } as StreamChunk, { type: 'done' } as StreamChunk]
    : scripts.get(req.model) ?? scripts.get('default') ?? []
  return (async function* () {
    for (const chunk of script) {
      if (req.signal.aborted) return
      yield chunk
    }
  })()
}

export function llmMockPlugin(ctx: Context): void {
  ctx.root.llm!.registerAdapter('mock', factory)
  ctx.effect(() => () => scripts.clear())
}

void Object.assign(llmMockPlugin, { inject: ['llm'] })
