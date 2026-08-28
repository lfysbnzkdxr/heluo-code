import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boot } from '../index'
import { registerMockStepScript } from '../plugins/llm-mock'
import type { StreamChunk } from '../services/llm/types'
import type { SessionHandle } from '../services/tools/types'
import type { SessionEvent } from '../shared/events'
import { createContext, shutdown } from '../context'
import { toolsPlugin } from '../services/tools'
import { hookLog, p3FixturePlugin } from './fixtures/p3-fixture-plugin'

// 本地路径形式加载的外部插件：相对 profile.cwd 解析
const coreRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const FIXTURE_REL = './src/__tests__/fixtures/p3-fixture-plugin.ts'

describe('P3 插件生态化', () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'heluo-p3-'))
    hookLog.length = 0
  })
  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('验收①：本地路径加载外部插件，工具被模型调用', async () => {
    const app = await boot(
      { cwd: coreRoot },
      {
        model: 'mock/fixture',
        providers: { mock: { type: 'mock' } },
        plugins: [FIXTURE_REL],
        permission: { mode: 'quest' },
      },
    )
    const ctx = app.ctx
    // 外部插件工具进入工具 schema 列表（模型可见）
    expect(ctx.tools!.getSchemaList().map((t) => t.name)).toContain('fixture_echo')
    expect(ctx.tools!.get('fixture_echo')).toBeDefined()

    registerMockStepScript('fixture', [
      [
        { type: 'text-delta', delta: '回显一下' },
        { type: 'tool-call', call: { id: 'e1', name: 'fixture_echo', argsJson: JSON.stringify({ text: 'hello' }) } },
        { type: 'done' },
      ],
      [{ type: 'text-delta', delta: '完成' }, { type: 'done' }],
    ])

    const session = ctx.agentLoop!.createSession(base)
    const events: SessionEvent[] = []
    session.subscribe((e) => events.push(e))
    const result = await ctx.agentLoop!.openTurn({ session, text: '调用外部插件工具' })
    await app.shutdown()

    expect(result.stopReason).toBe('completed')
    const calls = events.filter((e) => e.type === 'tool/call')
    expect(calls.map((e) => (e.properties as { name: string }).name)).toEqual(['fixture_echo'])
    const toolResult = events.find((e) => e.type === 'tool/result')!.properties as { output: string; isError: boolean }
    expect(toolResult.isError).toBe(false)
    expect(toolResult.output).toBe('echo: hello')
  })

  it('验收②：npm 包名加载 @heluo-code/plugin-web-fetch，web_fetch 被模型调用（真实 HTTP 往返）', async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body><h1>P3 server</h1><p>hello from fixture http server</p></body></html>')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    try {
      const app = await boot(
        { cwd: base },
        {
          model: 'mock/fetch',
          providers: { mock: { type: 'mock' } },
          plugins: ['@heluo-code/plugin-web-fetch'],
          permission: { mode: 'quest' },
        },
      )
      const ctx = app.ctx
      expect(ctx.tools!.get('web_fetch')).toBeDefined()

      registerMockStepScript('fetch', [
        [
          { type: 'text-delta', delta: '抓取网页' },
          {
            type: 'tool-call',
            call: { id: 'f1', name: 'web_fetch', argsJson: JSON.stringify({ url: `http://127.0.0.1:${port}/page` }) },
          },
          { type: 'done' },
        ],
        [{ type: 'text-delta', delta: '抓取完成' }, { type: 'done' }],
      ])

      const session = ctx.agentLoop!.createSession(base)
      const events: SessionEvent[] = []
      session.subscribe((e) => events.push(e))
      const result = await ctx.agentLoop!.openTurn({ session, text: '抓取一个网页' })
      await app.shutdown()

      expect(result.stopReason).toBe('completed')
      const toolResult = events.find((e) => e.type === 'tool/result')!.properties as {
        output: string
        isError: boolean
      }
      expect(toolResult.isError).toBe(false)
      // HTML 标签剥离后纯文本可读
      expect(toolResult.output).toContain('hello from fixture http server')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('验收③：插件卸载（dispose）无残留——工具注销、pre/post 钩子与事件监听全部反注册', async () => {
    const app = await boot(
      { cwd: coreRoot },
      {
        model: 'mock/unload',
        providers: { mock: { type: 'mock' } },
        plugins: [FIXTURE_REL],
        permission: { mode: 'quest' },
      },
    )
    const ctx = app.ctx
    const tools = ctx.tools!
    const cwd = base
    writeFileSync(resolve(cwd, 'a.txt'), 'hello')
    const fakeSession: SessionHandle = {
      id: 's3',
      cwd,
      inject: () => {},
      takeInject: () => [],
      append: (type, properties) =>
        ({ id: 'e', sessionId: 's3', schemaVersion: 1, timestamp: 0, type, properties }) as SessionEvent,
    }
    const tctx = { cwd, signal: new AbortController().signal, session: fakeSession, callId: 'x', inject: () => {} }
    // probe 工具不依赖任何内置服务（config 等），专用于探测钩子链残留
    tools.register({
      name: 'probe',
      description: '探测用工具',
      permission: 'allow',
      parameters: { type: 'object', properties: {} },
      execute: () => Promise.resolve({ ok: true, outputForModel: 'p' }),
    })

    // 挂载期：钩子与事件监听活跃
    const before = await tools.execute('probe', {}, tctx)
    expect(before.ok).toBe(true)
    expect(hookLog).toContain('pre')
    expect(hookLog).toContain('post')

    await app.shutdown()

    // 工具已注销
    expect(tools.get('fixture_echo')).toBeUndefined()
    expect(tools.get('fixture_secret')).toBeUndefined()

    // 瀑布钩子已反注册：执行工具不再触发 fixture 的 pre/post
    const n = hookLog.length
    const after = await tools.execute('probe', {}, tctx)
    expect(after.ok).toBe(true)
    expect(hookLog.length).toBe(n)

    // 事件监听已反注册
    ctx.emit('internal/status', null as never, 0 as never)
    expect(hookLog.length).toBe(n)
  })

  it('验收④：外部插件与内置权限插件在 pre-execute 链上共存——ask 工具同样被权限链拦截', async () => {
    const app = await boot(
      { cwd: coreRoot },
      {
        model: 'mock/secret',
        providers: { mock: { type: 'mock' } },
        plugins: [FIXTURE_REL],
        permission: { mode: 'agent' },
      },
    )
    const ctx = app.ctx
    registerMockStepScript('secret', [
      [
        { type: 'text-delta', delta: '要秘密' },
        { type: 'tool-call', call: { id: 's1', name: 'fixture_secret', argsJson: JSON.stringify({ value: '42' }) } },
        { type: 'done' },
      ],
      [{ type: 'text-delta', delta: '完成' }, { type: 'done' }],
    ])

    const session = ctx.agentLoop!.createSession(base)
    const events: SessionEvent[] = []
    session.subscribe((e) => events.push(e))
    const requests: Array<{ id: string; tool: string }> = []
    ctx.permissions!.onRequest((req) => {
      requests.push({ id: req.id, tool: req.tool })
      ctx.permissions!.respond(req.id, 'allow')
    })
    const result = await ctx.agentLoop!.openTurn({ session, text: '读取秘密' })
    await app.shutdown()

    expect(result.stopReason).toBe('completed')
    // 外部插件的 ask 工具走了内置权限链：产生 permission/request 且 allow 放行
    expect(requests.map((r) => r.tool)).toEqual(['fixture_secret'])
    expect(events.some((e) => e.type === 'permission/request')).toBe(true)
    const toolResult = events.find((e) => e.type === 'tool/result')!.properties as { output: string; isError: boolean }
    expect(toolResult.isError).toBe(false)
    expect(toolResult.output).toBe('secret: 42')
    // 共存：权限钩子放行后外部插件自身钩子照常执行，互相不覆盖
    expect(hookLog.filter((x) => x === 'pre').length).toBeGreaterThanOrEqual(1)
    expect(hookLog.filter((x) => x === 'post').length).toBeGreaterThanOrEqual(1)
  })

  it('验收⑤：provider 注册制——新增 provider 零核心改动，注册 adapter 即可切换', async () => {
    const app = await boot(
      { cwd: base },
      {
        model: 'custom/hello',
        providers: { custom: { type: 'my-test-adapter' } },
      },
    )
    const ctx = app.ctx
    let called = 0
    ctx.llm!.registerAdapter('my-test-adapter', () => {
      called++
      return (async function* () {
        yield { type: 'text-delta', delta: '来自自定义 adapter' } as StreamChunk
        yield { type: 'done' } as StreamChunk
      })()
    })

    const session = ctx.agentLoop!.createSession(base)
    const result = await ctx.agentLoop!.openTurn({ session, text: 'hello' })
    await app.shutdown()

    expect(result.stopReason).toBe('completed')
    expect(called).toBe(1)
  })

  it('加载失败不整体崩溃：坏路径插件报错后其余插件照常挂载', async () => {
    const app = await boot(
      { cwd: coreRoot },
      {
        model: 'mock/ok',
        providers: { mock: { type: 'mock' } },
        plugins: ['./src/__tests__/fixtures/does-not-exist.ts', FIXTURE_REL],
        permission: { mode: 'quest' },
      },
    )
    expect(app.ctx.tools!.get('fixture_echo')).toBeDefined()
    await app.shutdown()
  })

  it('p3FixturePlugin 为 §5.5 插件形态：{ name, inject, apply } 可直接被 Cordis 挂载', async () => {
    const ctx = createContext()
    await ctx.plugin(toolsPlugin)
    await ctx.plugin(p3FixturePlugin)
    expect(ctx.root.tools!.get('fixture_echo')).toBeDefined()
    await shutdown(ctx)
  })
})