import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContext } from '../../context'
import { sessionPlugin, type SessionService } from './index'
import { deriveMessages } from './derive'
import type { SessionEvent } from '../../shared/events'

const TEST_TMP = (() => { const dir = join(import.meta.dirname, '..', '..', '..', '..', '..', 'test-tmp'); mkdirSync(dir, { recursive: true }); return dir })()

function makeService(): SessionService {
  const ctx = createContext()
  sessionPlugin(ctx)
  return ctx.root.sessions!
}

function eventPath(sessionId: string): string {
  const home = process.env.HELUO_CODE_HOME!
  return join(home, 'sessions', `${sessionId}.jsonl`)
}

describe('session persistence (P6-pre JSONL)', () => {
  let cwd: string
  let service: SessionService
  beforeEach(() => {
    cwd = mkdtempSync(join(TEST_TMP, 'heluo-session-'))
    service = makeService()
    // 清理历史残留的持久化文件（sessionId 固定，多次运行会累积）
    const dir = join(process.env.HELUO_CODE_HOME!, 'sessions')
    for (const f of readdirSync(dir)) {
      if (f.startsWith('persist-')) rmSync(join(dir, f), { force: true })
    }
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('create 写盘：文件存在、每行可解析、schemaVersion 正确', () => {
    const s = service.create({ sessionId: 'persist-1', cwd })
    s.append('turn/start', { turnId: 't1' })
    s.append('user/message', { text: 'hi' })
    s.close()

    const lines = readFileSync(eventPath('persist-1'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    const ev = JSON.parse(lines[0]!) as SessionEvent
    expect(ev.sessionId).toBe('persist-1')
    expect(ev.schemaVersion).toBe(1)
    expect(ev.type).toBe('turn/start')
  })

  it('resume roundtrip：事件序列与 deriveMessages 投影一致', () => {
    const s = service.create({ sessionId: 'persist-2', cwd })
    s.append('turn/start', { turnId: 't1' })
    s.append('user/message', { text: 'hello' })
    s.append('assistant/message', { stepId: 's1', content: 'world' })
    s.append('turn/end', { turnId: 't1', stopReason: 'completed' })
    const before = deriveMessages(s.events)
    s.close()

    const restored = service.resume('persist-2', cwd)!
    expect(restored).toBeDefined()
    expect(restored.events.map((e) => e.type)).toEqual(['turn/start', 'user/message', 'assistant/message', 'turn/end'])
    expect(deriveMessages(restored.events)).toEqual(before)
    // 恢复后可继续追加（fd 续写）
    restored.append('user/message', { text: 'again' })
    restored.close()
    const lines = readFileSync(eventPath('persist-2'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(5)
  })

  it('半截尾行 / 坏行跳过并继续加载', () => {
    const s = service.create({ sessionId: 'persist-3', cwd })
    s.append('turn/start', { turnId: 't1' })
    s.append('user/message', { text: 'ok' })
    s.close()
    const file = eventPath('persist-3')
    appendFileSync(file, '{ bad json\n') // 坏行
    appendFileSync(file, '{"id":"x","sessionId":"persist-3","schemaVersion":1,"timestamp":1,"type":"user/message","properties":{"text":"tail"}') // 半截尾行

    const restored = service.resume('persist-3', cwd)!
    expect(restored.events).toHaveLength(2)
    expect(restored.events[0]!.type).toBe('turn/start')
  })

  it('未知事件类型行跳过（isSessionEvent 运行时校验）', () => {
    const s = service.create({ sessionId: 'persist-4', cwd })
    s.append('user/message', { text: 'a' })
    s.close()
    appendFileSync(eventPath('persist-4'), '{"id":"x","sessionId":"persist-4","schemaVersion":1,"timestamp":1,"type":"future/event","properties":{}}\n')

    const restored = service.resume('persist-4', cwd)!
    expect(restored.events).toHaveLength(1)
  })

  it('schemaVersion 不匹配拒绝加载', () => {
    const s = service.create({ sessionId: 'persist-5', cwd })
    s.append('user/message', { text: 'a' })
    s.close()
    writeFileSync(eventPath('persist-5'), '{"id":"x","sessionId":"persist-5","schemaVersion":2,"timestamp":1,"type":"user/message","properties":{"text":"a"}}\n')

    expect(service.resume('persist-5', cwd)).toBeUndefined()
  })

  it('不存在的文件 resume 返回 undefined', () => {
    expect(service.resume('no-such-session', cwd)).toBeUndefined()
  })

  it('close 后 append 不再写盘、内存继续', () => {
    const s = service.create({ sessionId: 'persist-6', cwd })
    s.append('user/message', { text: 'before' })
    s.close()
    s.append('user/message', { text: 'after' })
    const lines = readFileSync(eventPath('persist-6'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(s.events).toHaveLength(2)
  })

  it('create 默认 sessionId 时文件名与 store.sessionId 一致（可 resume）', () => {
    const s = service.create({ cwd })
    s.append('user/message', { text: 'x' })
    s.close()
    const restored = service.resume(s.sessionId, cwd)!
    expect(restored.events).toHaveLength(1)
  })
})