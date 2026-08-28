import { describe, expect, it } from 'vitest'
import { createContext } from '../../context'
import type { ToolContext, ToolOutcome } from '../../services/tools/types'
import { toolsPlugin } from '../../services/tools'
import { permissionsPlugin } from './index'

function tctx(): ToolContext {
  return {
    cwd: '/',
    signal: new AbortController().signal,
    session: { id: 's', cwd: '/', inject() {}, takeInject: () => [], append() { return {} as never } },
    inject() {},
  } as ToolContext
}

describe('permissions 插件', () => {
  it('allow 工具直接放行，不影响结果', async () => {
    const ctx = createContext()
    ctx.provide('config', { get: () => ({ permission: { mode: 'agent' as const } }) })
    toolsPlugin(ctx)
    permissionsPlugin(ctx)
    ctx.tools!.register({
      name: 'read_only',
      description: 'r',
      permission: 'allow',
      parameters: { type: 'object', properties: {} },
      async execute(): Promise<ToolOutcome> {
        return { ok: true, outputForModel: 'ok' }
      },
    })
    const out = await ctx.tools!.execute('read_only', {}, tctx())
    expect(out.ok).toBe(true)
  })

  it('ask 工具在 agent 模式需用户批准；deny 返回错误', async () => {
    const ctx = createContext()
    ctx.provide('config', { get: () => ({ permission: { mode: 'agent' as const } }) })
    toolsPlugin(ctx)
    permissionsPlugin(ctx)
    ctx.tools!.register({
      name: 'dangerous',
      description: 'w',
      permission: 'ask',
      parameters: { type: 'object', properties: {} },
      async execute(): Promise<ToolOutcome> {
        return { ok: true, outputForModel: 'done' }
      },
    })
    const pending: Array<{ id: string }> = []
    ctx.permissions!.onRequest((req) => pending.push({ id: req.id }))
    const promise = ctx.tools!.execute('dangerous', {}, tctx())
    expect(pending.length).toBe(1)
    ctx.permissions!.respond(pending[0]!.id, 'deny')
    const out = await promise
    expect(out.ok).toBe(false)
  })

  it('quest 模式对 ask 工具自动放行', async () => {
    const ctx = createContext()
    ctx.provide('config', { get: () => ({ permission: { mode: 'quest' as const } }) })
    toolsPlugin(ctx)
    permissionsPlugin(ctx)
    ctx.tools!.register({
      name: 'dangerous',
      description: 'w',
      permission: 'ask',
      parameters: { type: 'object', properties: {} },
      async execute(): Promise<ToolOutcome> {
        return { ok: true, outputForModel: 'done' }
      },
    })
    const out = await ctx.tools!.execute('dangerous', {}, tctx())
    expect(out.ok).toBe(true)
  })

  it('always 决策被记忆，同 session 内后续不再弹确认', async () => {
    const ctx = createContext()
    ctx.provide('config', { get: () => ({ permission: { mode: 'agent' as const } }) })
    toolsPlugin(ctx)
    permissionsPlugin(ctx)
    ctx.tools!.register({
      name: 'dangerous',
      description: 'w',
      permission: 'ask',
      parameters: { type: 'object', properties: {} },
      async execute(): Promise<ToolOutcome> {
        return { ok: true, outputForModel: 'done' }
      },
    })
    const session = {
      id: 's',
      cwd: '/',
      inject() {},
      takeInject: () => [],
      append() {
        return {} as never
      },
    } as ToolContext['session']
    const tc = (): ToolContext => ({
      cwd: '/',
      signal: new AbortController().signal,
      session,
      inject() {},
    } as ToolContext)
    const pending: Array<{ id: string }> = []
    ctx.permissions!.onRequest((req) => pending.push({ id: req.id }))

    const first = ctx.tools!.execute('dangerous', {}, tc())
    expect(pending.length).toBe(1)
    ctx.permissions!.respond(pending[0]!.id, 'always')
    await first

    pending.length = 0
    const second = await ctx.tools!.execute('dangerous', {}, tc())
    expect(second.ok).toBe(true)
    expect(pending.length).toBe(0)
  })
})
