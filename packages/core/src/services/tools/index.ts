import type { Context } from '@cordisjs/core'
import type { ToolSchema } from '../llm/types'
import type { ToolContext, ToolDefinition, ToolOutcome } from './types'

export type PreExecuteDecision = 'allow' | 'deny'

export type PreExecuteHook = (ctx: {
  tool: string
  args: unknown
  tctx: ToolContext
}) => PreExecuteDecision | Promise<PreExecuteDecision>

export type PostExecuteHook = (ctx: {
  tool: string
  args: unknown
  tctx: ToolContext
  outcome: ToolOutcome
}) => void | Promise<void>

export interface ToolService {
  register(tool: ToolDefinition): () => void
  getSchemaList(): ToolSchema[]
  get(name: string): ToolDefinition | undefined
  execute(name: string, args: unknown, tctx: ToolContext): Promise<ToolOutcome>
  onPreExecute(hook: PreExecuteHook): () => void
  onPostExecute(hook: PostExecuteHook): () => void
}

export function toolsPlugin(ctx: Context): void {
  const registry = new Map<string, ToolDefinition>()
  const preHooks: PreExecuteHook[] = []
  const postHooks: PostExecuteHook[] = []

  const service: ToolService = {
    register(tool) {
      registry.set(tool.name, tool)
      return () => registry.delete(tool.name)
    },
    getSchemaList() {
      return [...registry.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
    },
    get(name) {
      return registry.get(name)
    },
    async execute(name, args, tctx) {
      const tool = registry.get(name)
      if (!tool) {
        return { ok: false, errorForModel: `未知工具: ${name}` }
      }
      for (const hook of preHooks) {
        const decision = await hook({ tool: name, args, tctx })
        if (decision === 'deny') {
          return { ok: false, errorForModel: `工具 ${name} 被权限策略拒绝` }
        }
      }
      try {
        const outcome = await tool.execute(args, tctx)
        for (const hook of postHooks) {
          await hook({ tool: name, args, tctx, outcome })
        }
        return outcome
      } catch (error) {
        return { ok: false, errorForModel: error instanceof Error ? error.message : String(error) }
      }
    },
    onPreExecute(hook) {
      preHooks.push(hook)
      return () => {
        const idx = preHooks.indexOf(hook)
        if (idx >= 0) preHooks.splice(idx, 1)
      }
    },
    onPostExecute(hook) {
      postHooks.push(hook)
      return () => {
        const idx = postHooks.indexOf(hook)
        if (idx >= 0) postHooks.splice(idx, 1)
      }
    },
  }
  ctx.root.provide('tools', service)
}
