import type { ModelMessage } from 'ai'
import type { Context } from '@cordisjs/core'
import type { AdapterFactory, StreamChunk } from '../../services/llm/types'

const scripts = new Map<string, StreamChunk[]>()
const stepScripts = new Map<string, StreamChunk[][]>()

export function registerMockScript(name: string, chunks: StreamChunk[]): void {
  scripts.set(name, chunks)
}

// 多 step 脚本：第 i 次模型请求（i = 已出现的 tool 消息数）回放 steps[i]
export function registerMockStepScript(name: string, steps: StreamChunk[][]): void {
  stepScripts.set(name, steps)
}

function hasToolMessage(messages: ModelMessage[]): boolean {
  return messages.some((m) => m.role === 'tool')
}

const factory: AdapterFactory = (req) => {
  const alreadyRanTool = hasToolMessage(req.messages)
  const toolRounds = req.messages.filter((m) => m.role === 'tool').length
  const steps = stepScripts.get(req.model)
  const script = steps
    ? steps[Math.min(toolRounds, steps.length - 1)]!
    : alreadyRanTool
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
  ctx.effect(() => () => {
    scripts.clear()
    stepScripts.clear()
  })
}

void Object.assign(llmMockPlugin, { inject: ['llm'] })
