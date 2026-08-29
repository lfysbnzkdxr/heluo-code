import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionEventType } from '@heluo-code/core'
import { diffLines } from './DiffView'
import { createInitialState, reduceEvent, replay } from './session'

function ev<K extends SessionEventType>(type: K, properties: SessionEvent['properties'], id = randomUUID()): SessionEvent {
  return { id, sessionId: 's', schemaVersion: 1, timestamp: 0, type, properties } as SessionEvent
}

describe('renderer session reducer', () => {
  it('用户消息与助手流式 chunk 累积为消息序列', () => {
    let s = createInitialState()
    s = reduceEvent(s, ev('user/message', { text: '任务' }))
    s = reduceEvent(s, ev('assistant/chunk', { stepId: 'st1', delta: '你' }))
    s = reduceEvent(s, ev('assistant/chunk', { stepId: 'st1', delta: '好' }))
    s = reduceEvent(s, ev('assistant/chunk', { stepId: 'st2', delta: '第二段' }))

    expect(s.messages).toEqual([
      { id: expect.any(String), role: 'user', content: '任务' },
      { id: 'st1', role: 'assistant', content: '你好' },
      { id: 'st2', role: 'assistant', content: '第二段' },
    ])
  })

  it('assistant/message 落定事件不重复追加（chunk 已累积）', () => {
    let s = createInitialState()
    s = reduceEvent(s, ev('assistant/chunk', { stepId: 'st1', delta: '你好' }))
    s = reduceEvent(s, ev('assistant/message', { stepId: 'st1', content: '你好' }))
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]!.content).toBe('你好')
  })

  it('工具调用卡片：running → done/error', () => {
    let s = createInitialState()
    s = reduceEvent(s, ev('tool/call', { stepId: 'st1', callId: 'c1', name: 'write_file', args: { path: 'a.txt' } }))
    expect(s.toolCards[0]).toMatchObject({ callId: 'c1', name: 'write_file', status: 'running' })

    s = reduceEvent(s, ev('tool/result', { callId: 'c1', output: 'ok', isError: false, durationMs: 1 }))
    expect(s.toolCards[0]!.status).toBe('done')
    expect(s.toolCards[0]!.output).toBe('ok')

    s = reduceEvent(s, ev('tool/call', { stepId: 'st2', callId: 'c2', name: 'run_command', args: { command: 'x' } }))
    s = reduceEvent(s, ev('tool/result', { callId: 'c2', output: 'boom', isError: true, durationMs: 1 }))
    expect(s.toolCards[1]!.status).toBe('error')
  })

  it('权限三态：request 置 waiting-permission，allow/deny/always 响应后清除', () => {
    let s = createInitialState()
    s = reduceEvent(s, ev('turn/start', { turnId: 't1' }))
    s = reduceEvent(s, ev('permission/request', { id: 'r1', tool: 'write_file', argsSummary: '{}' }))
    expect(s.turnStatus).toBe('waiting-permission')
    expect(s.pendingPermission).toMatchObject({ id: 'r1', tool: 'write_file' })

    s = reduceEvent(s, ev('permission/response', { id: 'r1', decision: 'allow' }))
    expect(s.pendingPermission).toBeNull()
    expect(s.turnStatus).toBe('running')

    // always 与 deny 走同一路径
    s = reduceEvent(s, ev('permission/request', { id: 'r2', tool: 'write_file', argsSummary: '{}' }))
    s = reduceEvent(s, ev('permission/response', { id: 'r2', decision: 'always' }))
    expect(s.pendingPermission).toBeNull()

    s = reduceEvent(s, ev('permission/request', { id: 'r3', tool: 'run_command', argsSummary: '{}' }))
    s = reduceEvent(s, ev('permission/response', { id: 'r3', decision: 'deny' }))
    expect(s.pendingPermission).toBeNull()
    expect(s.turnStatus).toBe('running')
  })

  it('中断：权限等待中 abort → 响应 deny 清卡 → turn/end interrupted → idle', () => {
    let s = createInitialState()
    s = reduceEvent(s, ev('turn/start', { turnId: 't1' }))
    s = reduceEvent(s, ev('permission/request', { id: 'r1', tool: 'run_command', argsSummary: '{}' }))
    expect(s.turnStatus).toBe('waiting-permission')
    s = reduceEvent(s, ev('permission/response', { id: 'r1', decision: 'deny' }))
    s = reduceEvent(s, ev('turn/end', { turnId: 't1', stopReason: 'interrupted' }))
    expect(s.turnStatus).toBe('idle')
    expect(s.pendingPermission).toBeNull()
    expect(s.lastTurnEnd).toEqual({ stopReason: 'interrupted' })
  })

  it('turn/start→end 状态流转与 lastTurnEnd 记录', () => {
    let s = createInitialState()
    s = reduceEvent(s, ev('turn/start', { turnId: 't1' }))
    expect(s.turnStatus).toBe('running')
    s = reduceEvent(s, ev('turn/end', { turnId: 't1', stopReason: 'completed', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }))
    expect(s.turnStatus).toBe('idle')
    expect(s.lastTurnEnd).toEqual({ stopReason: 'completed', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
  })

  it('reasoning/chunk 按 stepId 累积为折叠块', () => {
    let s = createInitialState()
    s = reduceEvent(s, ev('reasoning/chunk', { stepId: 'st1', delta: '先' }))
    s = reduceEvent(s, ev('reasoning/chunk', { stepId: 'st1', delta: '想' }))
    s = reduceEvent(s, ev('reasoning/chunk', { stepId: 'st2', delta: '第二段' }))
    expect(s.reasonings).toEqual([
      { stepId: 'st1', content: '先想' },
      { stepId: 'st2', content: '第二段' },
    ])
  })

  it('tool/stream 按 callId 累积；result 到达后 output 为准', () => {
    let s = createInitialState()
    s = reduceEvent(s, ev('tool/call', { stepId: 'st1', callId: 'c1', name: 'run_command', args: { command: 'x' } }))
    s = reduceEvent(s, ev('tool/stream', { callId: 'c1', delta: 'out1' }))
    s = reduceEvent(s, ev('tool/stream', { callId: 'c1', delta: 'out2' }))
    expect(s.toolCards[0]!.stream).toBe('out1out2')
    expect(s.toolCards[0]!.status).toBe('running')

    s = reduceEvent(s, ev('tool/result', { callId: 'c1', output: '完整输出', isError: false, durationMs: 1 }))
    expect(s.toolCards[0]!.status).toBe('done')
    expect(s.toolCards[0]!.output).toBe('完整输出')
    expect(s.toolCards[0]!.stream).toBe('out1out2')
  })

  it('tool/stream 未知 callId 静默忽略（不产生新卡片）', () => {
    let s = createInitialState()
    s = reduceEvent(s, ev('tool/stream', { callId: 'ghost', delta: 'x' }))
    expect(s.toolCards).toHaveLength(0)
  })

  it('turn/end 无 usage 时 lastTurnEnd.usage 为 undefined（角标不显示）', () => {
    let s = createInitialState()
    s = reduceEvent(s, ev('turn/start', { turnId: 't1' }))
    s = reduceEvent(s, ev('turn/end', { turnId: 't1', stopReason: 'interrupted' }))
    expect(s.lastTurnEnd).toEqual({ stopReason: 'interrupted', usage: undefined })
  })

  it('tool/result 携带 diff 时落位到卡片', () => {
    let s = createInitialState()
    s = reduceEvent(s, ev('tool/call', { stepId: 'st1', callId: 'c1', name: 'write_file', args: { path: 'a.txt' } }))
    s = reduceEvent(s, ev('tool/result', { callId: 'c1', output: 'ok', isError: false, durationMs: 1, diff: { path: 'a.txt', before: '', after: 'hi' } }))
    expect(s.toolCards[0]!.diff).toEqual({ path: 'a.txt', before: '', after: 'hi' })
  })

  it('diffLines 行级对比：新增/删除/上下文正确标记', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc')).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'ctx', text: 'c' },
    ])
    expect(diffLines('', 'x\ny')).toEqual([
      { kind: 'add', text: 'x' },
      { kind: 'add', text: 'y' },
    ])
    expect(diffLines('x', '')).toEqual([{ kind: 'del', text: 'x' }])
    expect(diffLines('a\nb\nc', 'a\nb\nc')).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'ctx', text: 'b' },
      { kind: 'ctx', text: 'c' },
    ])
    // 尾随换行不产生多余的空行元素（仅末尾丢弃，中间空行保留）
    expect(diffLines('a\nb\n', 'a\nb')).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'ctx', text: 'b' },
    ])
    expect(diffLines('a\n', 'a\n\nb')).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'add', text: '' },
      { kind: 'add', text: 'b' },
    ])
  })

  it('replay：reasoning 与 tool/stream 重放幂等', () => {
    const events = [
      ev('turn/start', { turnId: 't1' }),
      ev('reasoning/chunk', { stepId: 'st1', delta: '思' }),
      ev('assistant/chunk', { stepId: 'st1', delta: '答' }),
      ev('tool/call', { stepId: 'st1', callId: 'c1', name: 'run_command', args: { command: 'x' } }),
      ev('tool/stream', { callId: 'c1', delta: 'a' }),
      ev('tool/stream', { callId: 'c1', delta: 'b' }),
      ev('tool/result', { callId: 'c1', output: 'ab', isError: false, durationMs: 1 }),
      ev('turn/end', { turnId: 't1', stopReason: 'completed', usage: { promptTokens: 3, completionTokens: 3, totalTokens: 6 } }),
    ]
    expect(replay(events)).toEqual(replay(events))
    const s = replay(events)
    expect(s.reasonings).toEqual([{ stepId: 'st1', content: '思' }])
    expect(s.toolCards[0]!.stream).toBe('ab')
    expect(s.lastTurnEnd!.usage!.totalTokens).toBe(6)
  })

  it('replay：从空状态重放同一事件流两次结果一致（幂等）', () => {
    const events = [
      ev('turn/start', { turnId: 't1' }),
      ev('user/message', { text: '任务' }),
      ev('assistant/chunk', { stepId: 'st1', delta: '嗨' }),
      ev('tool/call', { stepId: 'st1', callId: 'c1', name: 'write_file', args: { path: 'a.txt' } }),
      ev('tool/result', { callId: 'c1', output: 'ok', isError: false, durationMs: 1 }),
      ev('turn/end', { turnId: 't1', stopReason: 'completed' }),
    ]
    expect(replay(events)).toEqual(replay(events))
    expect(replay(events).turnStatus).toBe('idle')
    expect(replay(events).toolCards).toHaveLength(1)
  })
})