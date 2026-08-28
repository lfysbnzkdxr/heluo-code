import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionEventMap, SessionEventType } from '../../shared/events'
import { deriveMessages, estimateTokens } from './derive'

function ev<K extends SessionEventType>(type: K, properties: SessionEventMap[K], sessionId = 's1'): SessionEvent {
  return {
    id: Math.random().toString(36).slice(2),
    sessionId,
    schemaVersion: 1,
    timestamp: 0,
    type,
    properties,
  } as SessionEvent
}

describe('deriveMessages', () => {
  it('投影 user/assistant 文本消息为 ModelMessage', () => {
    const events = [
      ev('user/message', { text: 'hi' }),
      ev('assistant/message', { stepId: 'st1', content: 'hello' }),
    ]
    const { messages } = deriveMessages(events)
    expect(messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('把 tool/call + tool/result 投影为 assistant(tool-call) + tool(tool-result)', () => {
    const events = [
      ev('user/message', { text: '读文件' }),
      ev('assistant/message', { stepId: 'st1', content: '好' }),
      ev('tool/call', { stepId: 'st1', callId: 'c1', name: 'read_file', args: { path: 'a.ts' } }),
      ev('tool/result', { callId: 'c1', output: 'line1', isError: false, durationMs: 1 }),
    ]
    const { messages } = deriveMessages(events)
    expect(messages[0]).toEqual({ role: 'user', content: '读文件' })
    const assistant = messages[1] as { role: 'assistant'; content: Array<{ type: string }> }
    expect(assistant.role).toBe('assistant')
    expect(assistant.content[0]!).toEqual({ type: 'text', text: '好' })
    expect(assistant.content[1]!).toMatchObject({ type: 'tool-call', toolCallId: 'c1', toolName: 'read_file' })
    const tool = messages[2] as { role: 'tool'; content: Array<{ type: string; output: unknown }> }
    expect(tool.role).toBe('tool')
    expect(tool.content[0]!.type).toBe('tool-result')
    expect(tool.content[0]!.output).toEqual({ type: 'text', value: 'line1' })
  })

  it('仅工具调用（空文本）不产生空 text part', () => {
    const events = [
      ev('user/message', { text: '读文件' }),
      ev('assistant/message', { stepId: 'st1', content: '' }),
      ev('tool/call', { stepId: 'st1', callId: 'c1', name: 'read_file', args: { path: 'a.ts' } }),
      ev('tool/result', { callId: 'c1', output: 'line1', isError: false, durationMs: 1 }),
    ]
    const { messages } = deriveMessages(events)
    const assistant = messages[1] as { role: 'assistant'; content: Array<{ type: string; text?: string }> }
    expect(assistant.role).toBe('assistant')
    expect(assistant.content.some((p) => p.type === 'text' && (p.text ?? '') === '')).toBe(false)
    expect(assistant.content[0]!).toMatchObject({ type: 'tool-call', toolCallId: 'c1' })
  })

  it('单条超长消息被截断且不丢条数', () => {
    const longText = 'x'.repeat(200000)
    const events = [ev('user/message', { text: longText })]
    const { messages, trimmed } = deriveMessages(events)
    expect(trimmed).toBe(true)
    expect(messages.length).toBe(1)
    const content = (messages[0] as { content: string }).content
    expect(content.length).toBeLessThan(longText.length)
    expect(content).toContain('…[截断]')
  })

  it('裁剪时插入 history trimmed 标注', () => {
    const events: SessionEvent[] = []
    for (let i = 0; i < 25; i++) {
      events.push(ev('user/message', { text: 'x'.repeat(80) }))
    }
    const { messages, trimmed } = deriveMessages(events, { softCapTokens: 100 })
    expect(trimmed).toBe(true)
    const first = messages[0] as { role: string; content: string }
    expect(first.role).toBe('system')
    expect(first.content).toContain('[history trimmed')
    expect(first.content).toContain('5')
  })

  it('仅截断超长消息，短消息不受影响', () => {
    const events = [
      ev('user/message', { text: 'x'.repeat(200000) }),
      ev('assistant/message', { stepId: 'st1', content: 'short' }),
    ]
    const { messages } = deriveMessages(events)
    const long = messages[0] as { role: string; content: string }
    const short = messages[1] as { role: string; content: string }
    expect(long.role).toBe('user')
    expect(long.content.length).toBeLessThan(200000)
    expect(long.content).toContain('…[截断]')
    expect(short.content).toBe('short')
  })

  it('裁剪后无孤儿 tool 消息（assistant 被移除时连带删除 tool）', () => {
    const events: SessionEvent[] = [
      ev('assistant/message', { stepId: 'st1', content: 'x'.repeat(1200) }),
      ev('tool/call', { stepId: 'st1', callId: 'c1', name: 'read_file', args: { path: 'a' } }),
      ev('tool/result', { callId: 'c1', output: 'data', isError: false, durationMs: 1 }),
      ...Array.from({ length: 25 }, () => ev('user/message', { text: 'a' })),
    ]
    const { messages } = deriveMessages(events, { softCapTokens: 100 })
    expect(messages[0]).toMatchObject({ role: 'system' })
    expect(messages.some((m) => m.role === 'tool')).toBe(false)
  })

  it('多工具调用 step 的所有 tool-result 均保留（不误删第 2+ 个）', () => {
    const events = [
      ev('user/message', { text: '读两个文件' }),
      ev('assistant/message', { stepId: 'st1', content: '' }),
      ev('tool/call', { stepId: 'st1', callId: 'c1', name: 'read_file', args: { path: 'a' } }),
      ev('tool/call', { stepId: 'st1', callId: 'c2', name: 'read_file', args: { path: 'b' } }),
      ev('tool/result', { callId: 'c1', output: 'data1', isError: false, durationMs: 1 }),
      ev('tool/result', { callId: 'c2', output: 'data2', isError: false, durationMs: 1 }),
    ]
    const { messages } = deriveMessages(events)
    const tools = messages.filter((m) => m.role === 'tool')
    expect(tools.length).toBe(2)
    const ids = tools.map((t) =>
      Array.isArray(t.content) ? (t.content[0] as { toolCallId: string }).toolCallId : '',
    )
    expect(ids).toEqual(['c1', 'c2'])
  })

  it('真实事件顺序（tool/call 先于 assistant/message）投影正确且工具结果保留', () => {
    const events = [
      ev('user/message', { text: '读文件' }),
      ev('tool/call', { stepId: 'st1', callId: 'c1', name: 'read_file', args: { path: 'a.ts' } }),
      ev('assistant/message', { stepId: 'st1', content: '好' }),
      ev('tool/result', { callId: 'c1', output: 'line1', isError: false, durationMs: 1 }),
    ]
    const { messages } = deriveMessages(events)
    const assistant = messages[1] as { role: 'assistant'; content: Array<{ type: string }> }
    expect(assistant.content[0]).toEqual({ type: 'text', text: '好' })
    expect(assistant.content[1]).toMatchObject({ type: 'tool-call', toolCallId: 'c1' })
    expect(messages[2]).toMatchObject({ role: 'tool' })
  })
})

describe('estimateTokens', () => {
  it('CJK 与英文估算不同', () => {
    const cjk = estimateTokens('中文'.repeat(20))
    const en = estimateTokens('ab'.repeat(20))
    expect(cjk).toBeGreaterThan(en)
  })
})
