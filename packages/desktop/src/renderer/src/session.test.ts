import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionEventType } from '@heluo-code/core'
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
    expect(s.lastTurnEnd).toEqual({ stopReason: 'completed' })
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