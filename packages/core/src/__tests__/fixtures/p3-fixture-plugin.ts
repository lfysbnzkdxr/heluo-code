import type { Context } from '@cordisjs/core'
import type { ToolOutcome } from '../../services/tools/types'

// 模块级日志：供 p3-plugins.test.ts 断言插件卸载后无残留监听
export const hookLog: string[] = []

export const p3FixturePlugin = {
  name: 'p3-fixture',
  inject: ['tools'],
  apply(ctx: Context): void {
    ctx.effect(() =>
      ctx.root.tools!.register({
        name: 'fixture_echo',
        description: 'P3 测试插件工具：原样回显输入',
        permission: 'allow',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        async execute(args: unknown): Promise<ToolOutcome> {
          const { text } = (args ?? {}) as { text?: unknown }
          return { ok: true, outputForModel: `echo: ${typeof text === 'string' ? text : String(text)}` }
        },
      }),
    )
    ctx.effect(() =>
      ctx.root.tools!.register({
        name: 'fixture_secret',
        description: 'P3 测试插件工具：ask 权限，验证外部工具同样走权限链',
        permission: 'ask',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        async execute(args: unknown): Promise<ToolOutcome> {
          const { value } = (args ?? {}) as { value?: unknown }
          return { ok: true, outputForModel: `secret: ${typeof value === 'string' ? value : String(value)}` }
        },
      }),
    )
    ctx.effect(() =>
      ctx.root.tools!.onPreExecute(() => {
        hookLog.push('pre')
        return 'allow'
      }),
    )
    ctx.effect(() =>
      ctx.root.tools!.onPostExecute(() => {
        hookLog.push('post')
      }),
    )
    ctx.effect(() =>
      ctx.on('internal/status', () => {
        hookLog.push('event')
      }),
    )
  },
}

export default p3FixturePlugin