import type { Context } from '@cordisjs/core'
import { logger } from '../../shared/logger'

export function toolsSpawnPlugin(ctx: Context): void {
  ctx.root.tools!.register({
    name: 'spawn_subagent',
    description:
      '创建子代理（subagent）并行执行子任务并等待其完成，返回摘要。' +
      '子代理拥有独立会话与受限工具集，完成后仅将摘要回传主会话（上下文隔离）。' +
      '探索类任务可用 definitionId "explorer"（只读工具集）。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '子任务描述（必填），作为子代理会话的首条用户消息' },
        definitionId: { type: 'string', description: '预定义 agent id（可选），缺省为通用子代理（继承全部工具）' },
      },
      required: ['task'],
    },
    permission: 'allow',
    async execute(args, tctx) {
      const { task, definitionId } = (args ?? {}) as { task?: unknown; definitionId?: unknown }
      if (typeof task !== 'string' || task.trim() === '') {
        return { ok: false, errorForModel: 'spawn_subagent 需要非空 task 参数' }
      }
      const defId = typeof definitionId === 'string' && definitionId.trim() !== '' ? definitionId : undefined
      if (defId && !ctx.root.agents!.getDefinition(defId)) {
        return { ok: false, errorForModel: `未知 agent definition: ${defId}` }
      }

      const handle = await ctx.root.agents!.create({
        definitionId: defId,
        task,
        parentSessionId: tctx.session.id,
        signal: tctx.signal,
      })
      tctx.session.append('subagent/spawn', { agentId: handle.id, task })
      logger.info('subagent spawned', { agentId: handle.id, definitionId: defId, task })

      await handle.waitDone()

      tctx.session.append('subagent/finished', { agentId: handle.id, summary: handle.summary ?? handle.error ?? '' })
      logger.info('subagent finished', { agentId: handle.id, status: handle.status })

      const lines = [
        `[subagent ${handle.id} 完成]`,
        `任务: ${task}`,
        `状态: ${handle.status}`,
      ]
      if (handle.status === 'failed') {
        lines.push(`错误: ${handle.error ?? '未知错误'}`)
      } else {
        lines.push(`摘要: ${handle.summary ?? ''}`)
      }
      return { ok: true, outputForModel: lines.join('\n') }
    },
  })
}

void Object.assign(toolsSpawnPlugin, { inject: ['agents'] })