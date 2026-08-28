import { describe, expect, it } from 'vitest'
import { createContext } from '../../context'
import type { ToolContext, ToolDefinition, ToolOutcome } from './types'
import { toolsPlugin } from './index'

function makeService() {
  const ctx = createContext()
  toolsPlugin(ctx)
  return ctx.tools!
}

function tool(name: string, permission: 'allow' | 'ask' = 'allow'): ToolDefinition {
  return {
    name,
    description: name,
    permission,
    parameters: { type: 'object', properties: {} },
    async execute(): Promise<ToolOutcome> {
      return { ok: true, outputForModel: `ran ${name}` }
    },
  }
}

describe('ToolService', () => {
  it('getSchemaList 按名称排序（保 prompt cache）', () => {
    const svc = makeService()
    svc.register(tool('zebra'))
    svc.register(tool('alpha'))
    expect(svc.getSchemaList().map((t) => t.name)).toEqual(['alpha', 'zebra'])
  })

  it('pre-execute 钩子可拒绝执行', async () => {
    const svc = makeService()
    svc.register(tool('alpha'))
    svc.onPreExecute(() => 'deny')
    const tctx = { cwd: '/', signal: new AbortController().signal, session: {} as unknown as ToolContext['session'], callId: 'c1', inject() {} } as ToolContext
    const out = await svc.execute('alpha', {}, tctx)
    expect(out.ok).toBe(false)
    expect((out as { errorForModel: string }).errorForModel).toContain('拒绝')
  })

  it('未知工具返回错误结果', async () => {
    const svc = makeService()
    const tctx = { cwd: '/', signal: new AbortController().signal, session: {} as unknown as ToolContext['session'], callId: 'c1', inject() {} } as ToolContext
    const out = await svc.execute('nope', {}, tctx)
    expect(out.ok).toBe(false)
  })
})
