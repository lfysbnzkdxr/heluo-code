import type { Context } from '@cordisjs/core'
import { createAgentLoop, type AgentLoopService } from './agentLoop'

export type { AgentLoopService, TurnResult, OpenTurnOptions } from './agentLoop'

export function agentLoopPlugin(ctx: Context): void {
  const service: AgentLoopService = createAgentLoop(ctx)
  ctx.root.provide('agentLoop', service)
}

void Object.assign(agentLoopPlugin, { inject: ['config', 'sessions', 'llm', 'tools', 'systemPrompt'] })
