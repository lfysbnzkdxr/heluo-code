import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContext, toolsPlugin, type SessionEvent, type SessionHandle, type ToolContext } from '@heluo-code/core'
import { webFetchPlugin } from './index'

describe('web-fetch 插件', () => {
  let server: Server
  let url: string
  let cwd: string

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'heluo-wf-'))
    server = createServer((req, res) => {
      if (req.url !== '/page') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body><h1>t</h1><p>plain text here</p></body></html>')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/page`
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  async function withPlugin<T>(fn: (ctx: ReturnType<typeof createContext>, tctx: ToolContext) => Promise<T>): Promise<T> {
    const ctx = createContext()
    await ctx.plugin(toolsPlugin)
    await ctx.plugin(webFetchPlugin)
    const session: SessionHandle = {
      id: 's',
      cwd,
      inject: () => {},
      takeInject: () => [] as string[],
      append: (type, properties) =>
        ({ id: 'e', sessionId: 's', schemaVersion: 1, timestamp: 0, type, properties }) as SessionEvent,
    }
    const tctx: ToolContext = {
      cwd,
      signal: new AbortController().signal,
      session,
      callId: 'x',
      inject: () => {},
    }
    try {
      return await fn(ctx, tctx)
    } finally {
      await ctx.fiber.dispose()
    }
  }

  it('抓取 HTML 并剥离标签返回纯文本', async () => {
    await withPlugin(async (ctx, tctx) => {
      const outcome = await ctx.tools!.execute('web_fetch', { url }, tctx)
      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        expect(outcome.outputForModel).toContain('plain text here')
        expect(outcome.outputForModel).not.toContain('<html>')
      }
    })
  })

  it('拒绝非 http/https URL', async () => {
    await withPlugin(async (ctx, tctx) => {
      const outcome = await ctx.tools!.execute('web_fetch', { url: 'file:///etc/passwd' }, tctx)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.errorForModel).toContain('仅支持 http/https')
    })
  })

  it('缺少 url 参数报错', async () => {
    await withPlugin(async (ctx, tctx) => {
      const outcome = await ctx.tools!.execute('web_fetch', {}, tctx)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.errorForModel).toContain('缺少 url')
    })
  })

  it('dispose 后 web_fetch 工具注销（§5.5：注册经 ctx.effect 包裹）', async () => {
    const ctx = createContext()
    await ctx.plugin(toolsPlugin)
    await ctx.plugin(webFetchPlugin)
    const tools = ctx.root.tools!
    expect(tools.get('web_fetch')).toBeDefined()
    await ctx.fiber.dispose()
    expect(tools.get('web_fetch')).toBeUndefined()
  })

  it('HTTP 错误状态返回错误结果', async () => {
    await withPlugin(async (ctx, tctx) => {
      const outcome = await ctx.tools!.execute('web_fetch', { url: `${url}-missing` }, tctx)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.errorForModel).toContain('HTTP 404')
    })
  })
})