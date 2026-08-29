import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boot } from '../index'
import type { Config } from '../plugins/config/schema'
import type { DeepPartial } from '../shared/types'
import { registerMockScript } from '../plugins/llm-mock'
import type { AdapterFactory, StreamChunk } from '../services/llm/types'
import type { SessionEvent } from '../shared/events'

const TEST_TMP = (() => { const dir = join(import.meta.dirname, '..', '..', '..', '..', 'test-tmp'); mkdirSync(dir, { recursive: true }); return dir })()
async function setup(overrides: DeepPartial<Config> = {}) {
  const cwd = mkdtempSync(join(TEST_TMP, 'heluo-turn-'))
  writeFileSync(join(cwd, 'foo.ts'), 'export const a = 1\n')
  const app = await boot(
    { cwd },
    {
      model: 'mock/demo',
      providers: { mock: { type: 'mock' } },
      permission: { mode: 'quest' },
      ...overrides,
    },
  )
  return { app, cwd }
}

function assertInvariants(events: SessionEvent[]): void {
  const types = events.map((e) => e.type)
  expect(types[0]).toBe('turn/start')
  expect(types[types.length - 1]).toBe('turn/end')
  const turns = events.filter((e) => e.type === 'turn/start').length
  const ends = events.filter((e) => e.type === 'turn/end').length
  expect(turns).toBe(1)
  expect(ends).toBe(1)
  for (const step of events.filter((e) => e.type === 'step/start')) {
    const stepId = (step.properties as { stepId: string }).stepId
    expect(events.some((e) => e.type === 'step/end' && (e.properties as { stepId: string }).stepId === stepId)).toBe(true)
  }
  const turnEnd = events.find((e) => e.type === 'turn/end')!
  expect(['completed', 'interrupted', 'error']).toContain((turnEnd.properties as { stopReason: string }).stopReason)
}

describe('agentLoop 集成（mock provider + read_file）', () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(TEST_TMP, 'heluo-'))
  })
  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('跑通一次含工具调用的 turn，并满足 SessionEvent 不变量', async () => {
    const { app, cwd } = await setup()
    const ctx = app.ctx
    registerMockScript('demo', [
      { type: 'text-delta', delta: '读取文件…' },
      { type: 'tool-call', call: { id: 'call1', name: 'read_file', argsJson: JSON.stringify({ path: 'foo.ts' }) } },
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      { type: 'done' },
    ])

    const session = ctx.agentLoop!.createSession(cwd)
    const events: SessionEvent[] = []
    const unsub = session.subscribe((e) => events.push(e))

    const result = await ctx.agentLoop!.openTurn({ session, text: '读一下 foo.ts' })

    unsub()
    await app.shutdown()

    expect(result.stopReason).toBe('completed')
    expect(result.usage?.totalTokens).toBe(15)
    assertInvariants(events)

    const toolCall = events.find((e) => e.type === 'tool/call')
    expect(toolCall).toBeDefined()
    expect((toolCall!.properties as { name: string }).name).toBe('read_file')
    const toolResult = events.find((e) => e.type === 'tool/result')
    expect(toolResult).toBeDefined()
    expect((toolResult!.properties as { isError: boolean }).isError).toBe(false)
    expect((toolResult!.properties as { output: string }).output).toContain('export const a = 1')
    const userMsg = events.find((e) => e.type === 'user/message')
    expect((userMsg!.properties as { text: string }).text).toBe('读一下 foo.ts')
  })

  it('错误路径：工具抛出异常时 tool/result 为 isError 且 turn 正常闭合', async () => {
    const { app, cwd } = await setup()
    const ctx = app.ctx
    registerMockScript('demo', [
      { type: 'tool-call', call: { id: 'call2', name: 'read_file', argsJson: JSON.stringify({ path: 'nope.ts' }) } },
      { type: 'done' },
    ])

    const session = ctx.agentLoop!.createSession(cwd)
    const events: SessionEvent[] = []
    session.subscribe((e) => events.push(e))

    const result = await ctx.agentLoop!.openTurn({ session, text: '读不存在的文件' })
    await app.shutdown()

    expect(result.stopReason).toBe('completed')
    const toolResult = events.find((e) => e.type === 'tool/result')!
    expect((toolResult.properties as { isError: boolean }).isError).toBe(true)
    assertInvariants(events)
  })

  it('中断：signal 已中止时 turn 以 interrupted 闭合', async () => {
    const { app, cwd } = await setup()
    const ctx = app.ctx

    const session = ctx.agentLoop!.createSession(cwd)
    const events: SessionEvent[] = []
    session.subscribe((e) => events.push(e))

    const controller = new AbortController()
    controller.abort()
    const result = await ctx.agentLoop!.openTurn({ session, text: '长时间任务', signal: controller.signal })
    await app.shutdown()

    expect(result.stopReason).toBe('interrupted')
    assertInvariants(events)
  })

  it('注入内容回灌模型（下一请求含注入 system 消息）', async () => {
    const cwd = mkdtempSync(join(TEST_TMP, 'heluo-inject-'))
    const app = await boot(
      { cwd },
      { model: 'capture/demo', providers: { capture: { type: 'capture' } }, permission: { mode: 'quest' } },
    )
    const ctx = app.ctx
    const captured: ModelMessage[][] = []
    const captureFactory: AdapterFactory = (req) => {
      captured.push(req.messages)
      const alreadyTool = req.messages.some((m) => m.role === 'tool')
      const script: StreamChunk[] = alreadyTool
        ? [{ type: 'text-delta', delta: 'final' }, { type: 'done' }]
        : [{ type: 'tool-call', call: { id: 'c1', name: 'note', argsJson: '{}' } }, { type: 'done' }]
      return (async function* () {
        for (const c of script) yield c
      })()
    }
    ctx.root.llm!.registerAdapter('capture', captureFactory)
    ctx.root.tools!.register({
      name: 'note',
      description: '注入测试工具',
      permission: 'allow',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(_args: unknown, tctx) {
        tctx.inject('SECRET')
        return { ok: true, outputForModel: 'noted' }
      },
    })

    const session = ctx.agentLoop!.createSession(cwd)
    const result = await ctx.agentLoop!.openTurn({ session, text: '注入测试' })
    await app.shutdown()

    expect(result.stopReason).toBe('completed')
    expect(captured.length).toBeGreaterThanOrEqual(2)
    const second = captured[1]!
    const injected = second.find(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('SECRET'),
    )
    expect(injected).toBeDefined()
  })

  it('权限等待中 abort 不挂起，turn 以 interrupted 闭合', async () => {
    const { app, cwd } = await setup({ permission: { mode: 'ask' } })
    const ctx = app.ctx
    registerMockScript('demo', [
      {
        type: 'tool-call',
        call: { id: 'w1', name: 'write_file', argsJson: JSON.stringify({ path: 'x.txt', content: 'hi' }) },
      },
      { type: 'done' },
    ])

    const session = ctx.agentLoop!.createSession(cwd)
    const controller = new AbortController()
    const p = ctx.agentLoop!.openTurn({ session, text: '写文件', signal: controller.signal })
    const timer = setTimeout(() => controller.abort(), 20)
    const result = await Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('HANG')), 800)),
    ])
    clearTimeout(timer)
    await app.shutdown()

    expect(result.stopReason).toBe('interrupted')
  })

  it('仅 reasoning 无文本无工具的步骤不产生空 assistant 消息', async () => {
    const cwd = mkdtempSync(join(TEST_TMP, 'heluo-reason-'))
    const app = await boot(
      { cwd },
      { model: 'reason/x', providers: { reason: { type: 'reason' } }, permission: { mode: 'quest' } },
    )
    const ctx = app.ctx
    const reasonFactory: AdapterFactory = () =>
      (async function* () {
        yield { type: 'reasoning-delta', delta: 'thinking' }
        yield { type: 'done' }
      })()
    ctx.root.llm!.registerAdapter('reason', reasonFactory)

    const session = ctx.agentLoop!.createSession(cwd)
    const events: SessionEvent[] = []
    session.subscribe((e) => events.push(e))
    const result = await ctx.agentLoop!.openTurn({ session, text: '思考' })
    await app.shutdown()

    expect(result.stopReason).toBe('completed')
    const emptyAssistant = events.filter(
      (e) => e.type === 'assistant/message' && (e.properties as { content: string }).content === '',
    )
    expect(emptyAssistant.length).toBe(0)
  })

  it('流式中断的半截文本不落定 assistant/message', async () => {
    const cwd = mkdtempSync(join(TEST_TMP, 'heluo-halftext-'))
    const app = await boot(
      { cwd },
      { model: 'halftext/x', providers: { halftext: { type: 'halftext' } }, permission: { mode: 'quest' } },
    )
    const ctx = app.ctx
    const halfTextFactory: AdapterFactory = (req) =>
      (async function* () {
        yield { type: 'text-delta', delta: 'hello ' } as StreamChunk
        await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve(), { once: true }))
      })()
    ctx.root.llm!.registerAdapter('halftext', halfTextFactory)

    const session = ctx.agentLoop!.createSession(cwd)
    const events: SessionEvent[] = []
    session.subscribe((e) => events.push(e))

    const controller = new AbortController()
    const p = ctx.agentLoop!.openTurn({ session, text: '输出半截', signal: controller.signal })
    const timer = setTimeout(() => controller.abort(), 20)
    const result = await Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('HANG')), 800)),
    ])
    clearTimeout(timer)
    await app.shutdown()

    expect(result.stopReason).toBe('interrupted')
    const halfAssistant = events.filter(
      (e) => e.type === 'assistant/message' && (e.properties as { content: string }).content.includes('hello'),
    )
    expect(halfAssistant.length).toBe(0)
    assertInvariants(events)
  })

  it('system prompt 在 turn 内 step 间保持一致（保前缀缓存）', async () => {
    const cwd = mkdtempSync(join(TEST_TMP, 'heluo-sysprompt-'))
    const app = await boot(
      { cwd },
      { model: 'capture/demo', providers: { capture: { type: 'capture' } }, permission: { mode: 'quest' } },
    )
    const ctx = app.ctx
    const captured: ModelMessage[][] = []
    const captureFactory: AdapterFactory = (req) => {
      captured.push(req.messages)
      const alreadyTool = req.messages.some((m) => m.role === 'tool')
      const script: StreamChunk[] = alreadyTool
        ? [{ type: 'text-delta', delta: 'final' }, { type: 'done' }]
        : [{ type: 'tool-call', call: { id: 'c1', name: 'note', argsJson: '{}' } }, { type: 'done' }]
      return (async function* () {
        for (const c of script) yield c
      })()
    }
    ctx.root.llm!.registerAdapter('capture', captureFactory)
    ctx.root.tools!.register({
      name: 'note',
      description: '注入测试工具',
      permission: 'allow',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute() {
        return { ok: true, outputForModel: 'noted' }
      },
    })

    const session = ctx.agentLoop!.createSession(cwd)
    const result = await ctx.agentLoop!.openTurn({ session, text: '两次请求' })
    await app.shutdown()

    expect(result.stopReason).toBe('completed')
    expect(captured.length).toBeGreaterThanOrEqual(2)
    const sys = (msgs: ModelMessage[]) =>
      msgs.find((m) => m.role === 'system' && typeof m.content === 'string' && (m.content as string).includes('heluo-code'))
    const sys0 = sys(captured[0]!)
    const sys1 = sys(captured[1]!)
    expect(sys0).toBeDefined()
    expect(sys1).toBeDefined()
    expect((sys0 as { content: string }).content).toBe((sys1 as { content: string }).content)
  })

  it('contextWindow 声明经 softCap 生效（超长消息被截断）', async () => {
    const cwd = mkdtempSync(join(TEST_TMP, 'heluo-softcap-'))
    const app = await boot(
      { cwd },
      {
        model: 'capture/demo',
        providers: { capture: { type: 'capture', contextWindow: 100 } },
        permission: { mode: 'quest' },
      },
    )
    const ctx = app.ctx
    const captured: ModelMessage[][] = []
    const captureFactory: AdapterFactory = (req) => {
      captured.push(req.messages)
      return (async function* () {
        yield { type: 'text-delta', delta: 'ok' }
        yield { type: 'done' }
      })()
    }
    ctx.root.llm!.registerAdapter('capture', captureFactory)

    const session = ctx.agentLoop!.createSession(cwd)
    const result = await ctx.agentLoop!.openTurn({ session, text: 'x'.repeat(200000) })
    await app.shutdown()

    expect(result.stopReason).toBe('completed')
    const first = captured[0]!.find((m) => m.role === 'user') as { content: string } | undefined
    expect(first).toBeDefined()
    expect((first as { content: string }).content.length).toBeLessThan(1000)
  })

  it('一步多个工具调用时全部执行且 tool/result 均落日志', async () => {
    const { app, cwd } = await setup()
    const ctx = app.ctx
    registerMockScript('demo', [
      { type: 'tool-call', call: { id: 'm1', name: 'read_file', argsJson: JSON.stringify({ path: 'foo.ts' }) } },
      { type: 'tool-call', call: { id: 'm2', name: 'read_file', argsJson: JSON.stringify({ path: 'foo.ts' }) } },
      { type: 'done' },
    ])

    const session = ctx.agentLoop!.createSession(cwd)
    const events: SessionEvent[] = []
    session.subscribe((e) => events.push(e))
    const result = await ctx.agentLoop!.openTurn({ session, text: '读两次' })
    await app.shutdown()

    expect(result.stopReason).toBe('completed')
    const results = events.filter((e) => e.type === 'tool/result')
    expect(results.length).toBe(2)
    expect(results.every((e) => (e.properties as { isError: boolean }).isError === false)).toBe(true)
  })

  it('优雅退出：权限等待中 shutdown 解挂，turn 以 interrupted 闭合且日志自洽', async () => {
    const { app, cwd } = await setup({ permission: { mode: 'ask' } })
    const ctx = app.ctx
    registerMockScript('demo', [
      {
        type: 'tool-call',
        call: { id: 'g1', name: 'write_file', argsJson: JSON.stringify({ path: 'x.txt', content: 'hi' }) },
      },
      { type: 'done' },
    ])

    const session = ctx.agentLoop!.createSession(cwd)
    const events: SessionEvent[] = []
    session.subscribe((e) => events.push(e))
    const p = ctx.agentLoop!.openTurn({ session, text: '写文件' })
    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, 20)),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('HANG before shutdown')), 800)),
    ])

    const shutdownPromise = app.shutdown()
    const result = await Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('HANG after shutdown')), 3000)),
    ])
    await shutdownPromise

    expect(result.stopReason).toBe('interrupted')
    assertInvariants(events)
    const resp = events.find((e) => e.type === 'permission/response')
    expect(resp).toBeDefined()
    expect((resp!.properties as { decision: string }).decision).toBe('deny')
  })
})
