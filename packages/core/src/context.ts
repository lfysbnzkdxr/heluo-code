import { Context } from '@cordisjs/core'
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

export async function shutdown(ctx: Context): Promise<void> {
  await ctx.fiber?.dispose()
}
