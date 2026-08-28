import type { ModelMessage } from 'ai'
import type { SessionEvent, TokenUsage } from '../../shared/events'

function isCJK(codePoint: number): boolean {
  return (
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3000 && codePoint <= 0x30ff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf)
  )
}

export function estimateTokens(text: string): number {
  let sum = 0
  for (const ch of text) {
    sum += isCJK(ch.codePointAt(0) ?? 0) ? 1 / 3.5 : 1 / 4
  }
  return Math.ceil(sum)
}

export interface DeriveOptions {
  softCapTokens?: number
  keepLast?: number
}

export interface DeriveResult {
  messages: ModelMessage[]
  trimmed: boolean
}

export function deriveMessages(events: SessionEvent[], opts: DeriveOptions = {}): DeriveResult {
  const softCap = opts.softCapTokens ?? 32000
  const keepLast = opts.keepLast ?? 20
  const messages: ModelMessage[] = []
  const callNames = new Map<string, string>()
  // agentLoop 真实事件顺序为 tool/call 先于 assistant/message（流式循环中先记录 tool/call，
  // 流结束后才落定 assistant/message）。tool/call 投影不依赖「上一条是 assistant」，
  // 而是按 stepId 关联：assistant 已在场则直接挂载，否则暂存待 assistant/message 落定时挂载。
  const pendingCalls = new Map<string, { callId: string; name: string; args: unknown }[]>()
  let lastAssistantStepId: string | null = null

  for (const ev of events) {
    switch (ev.type) {
      case 'user/message':
        messages.push({ role: 'user', content: ev.properties.text })
        break
      case 'assistant/message': {
        lastAssistantStepId = ev.properties.stepId
        const calls = pendingCalls.get(ev.properties.stepId) ?? []
        if (calls.length > 0) {
          pendingCalls.delete(ev.properties.stepId)
          const parts: Extract<ModelMessage, { role: 'assistant' }>['content'] = []
          if (ev.properties.content) {
            parts.push({ type: 'text' as const, text: ev.properties.content })
          }
          for (const c of calls) {
            parts.push({
              type: 'tool-call',
              toolCallId: c.callId,
              toolName: c.name,
              input: (c.args ?? {}) as Record<string, unknown>,
            })
          }
          messages.push({ role: 'assistant', content: parts })
        } else {
          messages.push({ role: 'assistant', content: ev.properties.content })
        }
        break
      }
      case 'tool/call': {
        callNames.set(ev.properties.callId, ev.properties.name)
        const last = messages.at(-1)
        if (last && last.role === 'assistant' && lastAssistantStepId === ev.properties.stepId) {
          const content =
            typeof last.content === 'string'
              ? last.content
                ? [{ type: 'text' as const, text: last.content }]
                : []
              : [...last.content]
          content.push({
            type: 'tool-call',
            toolCallId: ev.properties.callId,
            toolName: ev.properties.name,
            input: (ev.properties.args ?? {}) as Record<string, unknown>,
          })
          last.content = content
        } else {
          const arr = pendingCalls.get(ev.properties.stepId) ?? []
          arr.push({ callId: ev.properties.callId, name: ev.properties.name, args: ev.properties.args })
          pendingCalls.set(ev.properties.stepId, arr)
        }
        break
      }
      case 'tool/result': {
        const name = callNames.get(ev.properties.callId) ?? 'unknown'
        messages.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: ev.properties.callId,
              toolName: name,
              output: { type: 'text', value: ev.properties.output },
            },
          ],
        })
        break
      }
      default:
        break
    }
  }

  let total = 0
  for (const m of messages) total += estimateTokens(messageText(m))

  let trimmed = false
  let removed = 0
  if (total > softCap) {
    while (messages.length > keepLast && total > softCap) {
      total -= estimateTokens(messageText(messages[0]!))
      messages.shift()
      trimmed = true
      removed++
    }
    if (removed > 0) {
      messages.unshift({
        role: 'system',
        content: `[history trimmed: 上下文超限，较早的 ${removed} 条消息已被移除]`,
      })
    }
    // 仍超 cap（如单条超长消息）：遍历截断所有超长消息，而非只截最近一条
    if (total > softCap && messages.length > 0) {
      const maxChars = Math.floor(softCap * 3.5)
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i]!
        if (estimateTokens(messageText(m)) > softCap) {
          messages[i] = truncateMessage(m, maxChars)
          trimmed = true
        }
      }
    }
  }

  // 清理孤儿 tool 消息：仅当剩余消息中不存在包含该 toolCallId 的 assistant tool-call part 时删除
  // （多 tool-call 场景派生为 [assistant(tc1,tc2), tool1, tool2]，tool2 前一条是 tool1，按 callId 锚定可避免误删）
  const liveCallIds = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue
    for (const part of m.content) {
      if (part.type === 'tool-call') liveCallIds.add(part.toolCallId)
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'tool') continue
    const parts = Array.isArray(m.content) ? m.content : []
    const callId = parts.find((p) => p.type === 'tool-result')?.toolCallId
    if (!callId || !liveCallIds.has(callId)) {
      messages.splice(i, 1)
    }
  }

  return { messages, trimmed }
}

function truncateMessage(m: ModelMessage, maxChars: number): ModelMessage {
  if (typeof m.content === 'string') {
    return m.content.length <= maxChars
      ? m
      : ({ ...m, content: m.content.slice(0, maxChars) + '…[截断]' } as ModelMessage)
  }
  const parts = m.content.map((p) =>
    p.type === 'text' && p.text.length > maxChars
      ? { ...p, text: p.text.slice(0, maxChars) + '…[截断]' }
      : p,
  )
  return { ...m, content: parts } as ModelMessage
}

function messageText(m: ModelMessage): string {
  if (typeof m.content === 'string') return m.content
  let out = ''
  for (const part of m.content) {
    if (part.type === 'text') out += part.text
    else if (part.type === 'tool-call') out += JSON.stringify(part.input)
    else if (part.type === 'tool-result') out += typeof part.output === 'string' ? part.output : JSON.stringify(part.output)
  }
  return out
}

export function sumUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage {
  if (!a && !b) return { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  return {
    promptTokens: (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0),
    completionTokens: (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0),
  }
}
