import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boot } from '../index'
import type { Config } from '../plugins/config/schema'
import type { DeepPartial } from '../shared/types'
import { registerMockScript, registerMockStepScript } from '../plugins/llm-mock'
import type { SessionEvent } from '../shared/events'

async function setup(overrides: DeepPartial<Config> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'heluo-p5-'))
  const app = await boot(
    { cwd },
    {
      model: 'mock/main',
      providers: { mock: { type: 'mock' } },
      permission: { mode: 'quest' },
      ...overrides,
    },
  )
  return { app, cwd }
}

const EXPLORER_TOOLS = ['read_file', 'list_dir', 'grep_search']

describe('P5 多 agent 编排（agents 服务 + spawn_subagent）', () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'heluo-p5-base-'))
  })
  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('主 agent 并行派发 2 个子 agent 探索任务并正确汇总结论（上下文隔离）', async () => {
    const { app, cwd } = await setup()
    const ctx = app.ctx
    writeFileSync(join(cwd, 'foo.ts'), 'export const a = 1\n')
    writeFileSync(join(cwd, 'bar.ts'), 'export const b = 2\n')
    ctx.agents!.registerDefinition({ id: 'probe-a', systemPrompt: 'probe a', model: 'mock/sub-a', tools: EXPLORER_TOOLS })
    ctx.agents!.registerDefinition({ id: 'probe-b', systemPrompt: 'probe b', model: 'mock/sub-b', tools: EXPLORER_TOOLS })

    registerMockStepScript('main', [
      [
        { type: 'text-delta', delta: '派发子代理 a…' },
        { type: 'tool-call', call: { id: 'm1', name: 'spawn_subagent', argsJson: JSON.stringify({ task: '探索 A：foo.ts 内容', definitionId: 'probe-a' }) } },
        { type: 'done' },
      ],
      [
        { type: 'tool-call', call: { id: 'm2', name: 'spawn_subagent', argsJson: JSON.stringify({ task: '探索 B：bar.ts 内容', definitionId: 'probe-b' }) } },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', delta: '汇总：A 与 B 的发现均已收集' },
        { type: 'done' },
      ],
    ])
    registerMockScript('sub-a', [
      { type: 'text-delta', delta: '结论A：foo.ts 导出 a' },
      { type: 'done' },
    ])
    registerMockScript('sub-b', [
      { type: 'text-delta', delta: '结论B：bar.ts 导出 b' },
      { type: 'done' },
    ])

    const session = ctx.agentLoop!.createSession(cwd)
    const events: SessionEvent[] = []
    session.subscribe((e) => events.push(e))

    const result = await ctx.agentLoop!.openTurn({ session, text: '并行探索两个文件' })

    expect(result.stopReason).toBe('completed')
    const spawns = events.filter((e) => e.type === 'subagent/spawn')
    const finished = events.filter((e) => e.type === 'subagent/finished')
    expect(spawns).toHaveLength(2)
    expect(finished).toHaveLength(2)
    const summaries = finished.map((e) => (e.properties as { summary: string }).summary).join('\n')
    expect(summaries).toContain('结论A')
    expect(summaries).toContain('结论B')

    const spawnResults = events.filter((e) => e.type === 'tool/result' && (e.properties as { output: string }).output.includes('[subagent'))
    expect(spawnResults).toHaveLength(2)

    // 上下文隔离：主会话不出现子 agent 内部 assistant 文本（结论只经摘要/工具结果回传）
    const assistantTexts = events
      .filter((e) => e.type === 'assistant/message')
      .map((e) => (e.properties as { content: string }).content)
      .join('\n')
    expect(assistantTexts.includes('结论A')).toBe(false)
    expect(assistantTexts.includes('结论B')).toBe(false)
    // 主会话事件不含子代理内部工具调用（子代理只调只读工具，主会话不应出现对应 tool/call）
    const parentToolNames = events.filter((e) => e.type === 'tool/call').map((e) => (e.properties as { name: string }).name)
    expect(parentToolNames).toEqual(['spawn_subagent', 'spawn_subagent'])

    // 子会话独立且不变量自洽
    for (const agentId of spawns.map((e) => (e.properties as { agentId: string }).agentId)) {
      const child = ctx.sessions!.get(ctx.agents!.get(agentId)!.sessionId)!
      const childEvents = child.getAll()
      expect(childEvents[0]!.type).toBe('turn/start')
      expect(childEvents.at(-1)!.type).toBe('turn/end')
      expect(childEvents.some((e) => e.type === 'user/message' && (e.properties as { text: string }).text.startsWith('探索'))).toBe(true)
      // 子会话不含编排事件（编排事实只写主会话）
      expect(childEvents.some((e) => e.type === 'subagent/spawn')).toBe(false)
    }

    await app.shutdown()
  })

  it('并发上限内两个子 agent 并行运行（同时 running）', async () => {
    const { app, cwd } = await setup()
    const ctx = app.ctx
    ctx.agents!.registerDefinition({ id: 'probe-x', systemPrompt: 'x', model: 'mock/sub-x' })
    registerMockScript('sub-x', [{ type: 'text-delta', delta: 'done' }, { type: 'done' }])

    const parent = ctx.agentLoop!.createSession(cwd)
    const h1 = await ctx.agents!.create({ task: 'A', definitionId: 'probe-x', parentSessionId: parent.id })
    const h2 = await ctx.agents!.create({ task: 'B', definitionId: 'probe-x', parentSessionId: parent.id })
    expect(h1.status).toBe('running')
    expect(h2.status).toBe('running')

    await Promise.all([h1.waitDone(), h2.waitDone()])
    expect(h1.status).toBe('done')
    expect(h2.status).toBe('done')
    await app.shutdown()
  })

  it('并发上限 1：第二个子 agent 排队（idle），首个完成后自动启动', async () => {
    const { app, cwd } = await setup({ agents: { maxConcurrency: 1 } })
    const ctx = app.ctx
    ctx.agents!.registerDefinition({ id: 'probe-y', systemPrompt: 'y', model: 'mock/sub-y' })
    registerMockScript('sub-y', [{ type: 'text-delta', delta: 'done' }, { type: 'done' }])

    const parent = ctx.agentLoop!.createSession(cwd)
    const h1 = await ctx.agents!.create({ task: 'A', definitionId: 'probe-y', parentSessionId: parent.id })
    const h2 = await ctx.agents!.create({ task: 'B', definitionId: 'probe-y', parentSessionId: parent.id })
    expect(h1.status).toBe('running')
    expect(h2.status).toBe('idle')

    await h1.waitDone()
    expect(h2.status).toBe('running')
    await h2.waitDone()
    expect(h2.status).toBe('done')
    await app.shutdown()
  })

  it('排队中的子 agent 可被 interrupt 取消', async () => {
    const { app, cwd } = await setup({ agents: { maxConcurrency: 1 } })
    const ctx = app.ctx
    ctx.agents!.registerDefinition({ id: 'probe-z', systemPrompt: 'z', model: 'mock/sub-z' })
    registerMockScript('sub-z', [{ type: 'text-delta', delta: 'done' }, { type: 'done' }])

    const parent = ctx.agentLoop!.createSession(cwd)
    const h1 = await ctx.agents!.create({ task: 'A', definitionId: 'probe-z', parentSessionId: parent.id })
    const h2 = await ctx.agents!.create({ task: 'B', definitionId: 'probe-z', parentSessionId: parent.id })
    expect(h2.status).toBe('idle')
    h2.interrupt()
    expect(h2.status).toBe('done')
    await h2.waitDone()
    await h1.waitDone()
    expect(ctx.agents!.get(h2.id)).toBeUndefined()
    await app.shutdown()
  })

  it('Q5：父 Quest 模式快照——子 agent 继承，ask 工具免确认', async () => {
    const { app, cwd } = await setup()
    const ctx = app.ctx
    writeFileSync(join(cwd, 'a.txt'), 'hello\n')
    ctx.agents!.registerDefinition({ id: 'writer', systemPrompt: 'w', model: 'mock/writer', tools: ['write_file'] })
    registerMockScript('writer', [
      { type: 'tool-call', call: { id: 'w1', name: 'write_file', argsJson: JSON.stringify({ path: 'a.txt', content: 'world\n' }) } },
      { type: 'done' },
    ])

    const parent = ctx.agentLoop!.createSession(cwd)
    const h = await ctx.agents!.create({ task: '写入', definitionId: 'writer', parentSessionId: parent.id })
    await h.waitDone()
    expect(h.status).toBe('done')

    const child = ctx.sessions!.get(h.sessionId)!
    expect(child.getAll().some((e) => e.type === 'permission/request')).toBe(false)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('world\n')
    await app.shutdown()
  })

  it('Q5：记忆隔离——子会话 always 不流入父会话（父会话同工具仍 ask）', async () => {
    const { app, cwd } = await setup({ permission: { mode: 'agent' } })
    const ctx = app.ctx
    writeFileSync(join(cwd, 'a.txt'), 'hello\n')
    ctx.agents!.registerDefinition({ id: 'writer2', systemPrompt: 'w', model: 'mock/w2', tools: ['write_file'] })
    registerMockScript('w2', [
      { type: 'tool-call', call: { id: 'w2a', name: 'write_file', argsJson: JSON.stringify({ path: 'a.txt', content: 'world\n' }) } },
      { type: 'done' },
    ])
    registerMockStepScript('main', [
      [
        { type: 'tool-call', call: { id: 'm1', name: 'spawn_subagent', argsJson: JSON.stringify({ task: '写入', definitionId: 'writer2' }) } },
        { type: 'done' },
      ],
      [
        { type: 'tool-call', call: { id: 'm2', name: 'write_file', argsJson: JSON.stringify({ path: 'a.txt', content: 'final\n' }) } },
        { type: 'done' },
      ],
      [{ type: 'text-delta', delta: '完成' }, { type: 'done' }],
    ])

    const statuses: string[] = []
    const unsubStatus = ctx.agents!.onStatusChange((h) => statuses.push(`${h.status}:${h.task}`))
    ctx.permissions!.onRequest((req) => ctx.permissions!.respond(req.id, 'always'))

    const session = ctx.agentLoop!.createSession(cwd)
    const events: SessionEvent[] = []
    session.subscribe((e) => events.push(e))
    const result = await ctx.agentLoop!.openTurn({ session, text: '写入并验证隔离' })
    unsubStatus()

    expect(result.stopReason).toBe('completed')
    const spawn = events.find((e) => e.type === 'subagent/spawn')!
    const agentId = (spawn.properties as { agentId: string }).agentId
    const child = ctx.sessions!.get(ctx.agents!.get(agentId)!.sessionId)!
    const childEvents = child.getAll()
    // 子会话内 write_file 走了权限确认并 always
    expect(childEvents.some((e) => e.type === 'permission/request' && (e.properties as { tool: string }).tool === 'write_file')).toBe(true)
    expect(childEvents.some((e) => e.type === 'permission/response' && (e.properties as { decision: string }).decision === 'always')).toBe(true)
    // 父会话随后自己调 write_file：仍触发权限请求（子会话 always 记忆未流入）→ 隔离成立
    const parentRequests = events.filter((e) => e.type === 'permission/request')
    expect(parentRequests).toHaveLength(1)
    expect((parentRequests[0]!.properties as { tool: string }).tool).toBe('write_file')
    // 状态流转覆盖 waiting-permission
    expect(statuses).toContain('waiting-permission:写入')
    expect(statuses).toContain('done:写入')
    await app.shutdown()
  })

  it('工具白名单：白名单外工具调用被拒绝（isError，不执行）', async () => {
    const { app, cwd } = await setup()
    const ctx = app.ctx
    writeFileSync(join(cwd, 'a.txt'), 'hello\n')
    ctx.agents!.registerDefinition({ id: 'readonly', systemPrompt: 'r', model: 'mock/ro', tools: ['read_file'] })
    registerMockScript('ro', [
      { type: 'tool-call', call: { id: 'r1', name: 'write_file', argsJson: JSON.stringify({ path: 'a.txt', content: 'x\n' }) } },
      { type: 'done' },
    ])

    const parent = ctx.agentLoop!.createSession(cwd)
    const h = await ctx.agents!.create({ task: '只读', definitionId: 'readonly', parentSessionId: parent.id })
    await h.waitDone()
    expect(h.status).toBe('done')

    const child = ctx.sessions!.get(h.sessionId)!
    const toolResult = child.getAll().find((e) => e.type === 'tool/result')!
    expect((toolResult.properties as { isError: boolean }).isError).toBe(true)
    expect((toolResult.properties as { output: string }).output).toContain('不在该子 agent 可用工具集')
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('hello\n')
    await app.shutdown()
  })

  it('父 turn 中断级联：在途子 agent 以 interrupted 闭合', async () => {
    const { app, cwd } = await setup({ permission: { mode: 'agent' } })
    const ctx = app.ctx
    writeFileSync(join(cwd, 'a.txt'), 'hello\n')
    ctx.agents!.registerDefinition({ id: 'slow', systemPrompt: 's', model: 'mock/slow', tools: ['write_file'] })
    registerMockScript('slow', [
      { type: 'tool-call', call: { id: 's1', name: 'write_file', argsJson: JSON.stringify({ path: 'a.txt', content: 'x\n' }) } },
      { type: 'done' },
    ])

    const parent = ctx.agentLoop!.createSession(cwd)
    const controller = new AbortController()
    const h = await ctx.agents!.create({
      task: '写文件',
      definitionId: 'slow',
      parentSessionId: parent.id,
      signal: controller.signal,
    })
    // 等子 agent 挂起在权限请求上（稳定中间态，避免定时器竞态）
    await new Promise<void>((resolve) => {
      const unsub = ctx.agents!.onStatusChange((hh) => {
        if (hh.id === h.id && hh.status === 'waiting-permission') {
          unsub()
          resolve()
        }
      })
    })
    controller.abort()
    await h.waitDone()
    expect(h.status).toBe('done')

    const child = ctx.sessions!.get(h.sessionId)!
    const turnEnd = child.getAll().find((e) => e.type === 'turn/end')!
    expect((turnEnd.properties as { stopReason: string }).stopReason).toBe('interrupted')
    await app.shutdown()
  })

  it('dispose 无残留：handle 注销、定义反注册、队列无悬挂', async () => {
    const { app, cwd } = await setup()
    const ctx = app.ctx
    const unreg = ctx.agents!.registerDefinition({ id: 'tmp-def', systemPrompt: 't', model: 'mock/tmp' })
    expect(ctx.agents!.getDefinition('tmp-def')).toBeDefined()
    unreg()
    expect(ctx.agents!.getDefinition('tmp-def')).toBeUndefined()

    const parent = ctx.agentLoop!.createSession(cwd)
    const h = await ctx.agents!.create({ task: 'x', parentSessionId: parent.id })
    expect(ctx.agents!.list()).toHaveLength(1)
    await ctx.agents!.dispose(h.id)
    expect(ctx.agents!.get(h.id)).toBeUndefined()
    expect(ctx.agents!.list()).toHaveLength(0)
    await app.shutdown()
  })

  it('spawn_subagent 参数校验：缺 task / 未知 definitionId 返回 isError', async () => {
    const { app, cwd } = await setup()
    const ctx = app.ctx
    registerMockStepScript('main', [
      [
        { type: 'tool-call', call: { id: 'e1', name: 'spawn_subagent', argsJson: JSON.stringify({}) } },
        { type: 'done' },
      ],
      [
        { type: 'tool-call', call: { id: 'e2', name: 'spawn_subagent', argsJson: JSON.stringify({ task: 'x', definitionId: 'nope' }) } },
        { type: 'done' },
      ],
      [{ type: 'text-delta', delta: '完成' }, { type: 'done' }],
    ])

    const session = ctx.agentLoop!.createSession(cwd)
    const events: SessionEvent[] = []
    session.subscribe((e) => events.push(e))
    const result = await ctx.agentLoop!.openTurn({ session, text: '参数校验' })
    await app.shutdown()

    expect(result.stopReason).toBe('completed')
    const toolResults = events.filter((e) => e.type === 'tool/result')
    expect(toolResults).toHaveLength(2)
    const outputs = toolResults.map((e) => (e.properties as { output: string }).output)
    expect(outputs[0]).toContain('需要非空 task')
    expect(outputs[1]).toContain('未知 agent definition')
    expect(events.some((e) => e.type === 'subagent/spawn')).toBe(false)
  })

  it('评审整改：dispose 时清理 sessionMode 覆盖（回落后 config 模式）', async () => {
    const { app, cwd } = await setup()
    const ctx = app.ctx
    ctx.agents!.registerDefinition({ id: 'strict', systemPrompt: 's', model: 'mock/strict', permissionMode: 'ask' })
    registerMockScript('strict', [{ type: 'text-delta', delta: 'ok' }, { type: 'done' }])

    const parent = ctx.agentLoop!.createSession(cwd)
    const h = await ctx.agents!.create({ task: 'x', definitionId: 'strict', parentSessionId: parent.id })
    await h.waitDone()
    expect(h.sessionId).not.toBe('')
    // 覆盖生效：definition.permissionMode='ask' 覆盖 config quest
    expect(ctx.permissions!.getEffectiveMode(h.sessionId)).toBe('ask')

    await ctx.agents!.dispose(h.id)
    // 覆盖表条目已清理：回落 config.permission.mode（quest）
    expect(ctx.permissions!.getEffectiveMode(h.sessionId)).toBe('quest')
    await app.shutdown()
  })

  it('评审整改：send() 窗口期缓冲——会话建立前的注入不丢失', async () => {
    const { app, cwd } = await setup({ agents: { maxConcurrency: 1 } })
    const ctx = app.ctx
    const seen: string[][] = []
    ctx.llm!.registerAdapter('inspect', (req) => {
      seen.push(
        req.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
      )
      return (async function* () {
        yield { type: 'text-delta', delta: 'ok' }
        yield { type: 'done' }
      })()
    })
    ctx.agents!.registerDefinition({ id: 'probe-send', systemPrompt: 's', model: 'inspect/x' })
    registerMockScript('sub-send', [{ type: 'text-delta', delta: 'ok' }, { type: 'done' }])

    const parent = ctx.agentLoop!.createSession(cwd)
    const h1 = await ctx.agents!.create({ task: 'A', definitionId: 'probe-send', parentSessionId: parent.id })
    const h2 = await ctx.agents!.create({ task: 'B', definitionId: 'probe-send', parentSessionId: parent.id })
    // h2 排队中（会话未建立）：send 落入窗口期缓冲
    expect(h2.status).toBe('idle')
    h2.send('早期注入')
    await Promise.all([h1.waitDone(), h2.waitDone()])
    expect(h2.status).toBe('done')

    // inspect adapter 收到的 h2 首个请求含注入上下文
    const requests = seen.filter((msgs) => msgs.some((m) => m.includes('[注入上下文] 早期注入')))
    expect(requests.length).toBeGreaterThan(0)
    await app.shutdown()
  })
})