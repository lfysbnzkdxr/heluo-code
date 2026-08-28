import { Context } from '@cordisjs/core'
import { logger } from './shared/logger'
import type { ConfigService } from './plugins/config'
import type { SessionService } from './services/session'
import type { LlmService } from './services/llm'
import type { ToolService } from './services/tools'
import type { AgentLoopService } from './services/loop'
import type { SystemPromptService } from './plugins/system-prompt'
import type { PermissionService } from './plugins/permissions'

declare module '@cordisjs/core' {
  interface Context {
    config?: ConfigService
    sessions?: SessionService
    llm?: LlmService
    tools?: ToolService
    systemPrompt?: SystemPromptService
    permissions?: PermissionService
    agentLoop?: AgentLoopService
  }
}

export type { Context }

export function createContext(): Context {
  return new Context()
}

// 优雅退出（SPEC §5.8）：中断全部活跃 turn → 等待至多 5s 让在途工具收尾（AbortSignal 传播，
// run_command 执行器负责杀进程树）→ 超时强杀残留由工具层完成 → 逆序卸载插件。
export async function shutdown(ctx: Context): Promise<void> {
  const loop = ctx.root.agentLoop
  if (loop) {
    loop.interruptAll()
    const deadline = Date.now() + 5000
    while (loop.hasActiveTurns() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (loop.hasActiveTurns()) {
      logger.warn('shutdown timeout: active turns still running, force disposing')
    }
  }
  await ctx.fiber?.dispose()
}
