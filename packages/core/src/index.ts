import { configPlugin } from './plugins/config'
import type { ConfigPluginOptions } from './plugins/config'
import { createContext, shutdown, type Context as HeluoContext } from './context'
import type { DeepPartial, Profile } from './shared/types'
import type { Config } from './plugins/config/schema'
import { sessionPlugin } from './services/session'
import { llmPlugin } from './services/llm'
import { toolsPlugin } from './services/tools'
import { agentLoopPlugin } from './services/loop'
import { systemPromptPlugin } from './plugins/system-prompt'
import { permissionsPlugin } from './plugins/permissions'
import { toolsFsPlugin } from './plugins/tools-fs'
import { toolsShellPlugin } from './plugins/tools-shell'
import { llmOpenAICompatiblePlugin } from './plugins/llm-openai-compatible'
import { llmMockPlugin } from './plugins/llm-mock'
import { pluginLoaderPlugin } from './plugins/plugin-loader'

export interface BootResult {
  ctx: HeluoContext
  shutdown(): Promise<void>
}

export async function boot(profile: Profile, overrides?: DeepPartial<Config>): Promise<BootResult> {
  const ctx = createContext()
  const options: ConfigPluginOptions = { profile, overrides }
  await ctx.plugin(configPlugin, options)
  await ctx.plugin(sessionPlugin)
  await ctx.plugin(llmPlugin)
  await ctx.plugin(toolsPlugin)
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(permissionsPlugin)
  await ctx.plugin(toolsFsPlugin)
  await ctx.plugin(toolsShellPlugin)
  await ctx.plugin(llmOpenAICompatiblePlugin)
  await ctx.plugin(llmMockPlugin)
  await ctx.plugin(agentLoopPlugin)
  await ctx.plugin(pluginLoaderPlugin, { profile })
  return {
    ctx,
    shutdown: () => shutdown(ctx),
  }
}

export { createContext } from './context'
export type { Context } from './context'
export { configPlugin, buildConfig, assertGlobalOnly } from './plugins/config'
export type { ConfigService } from './plugins/config'
export { sessionPlugin } from './services/session'
export type { SessionStore } from './services/session/store'
export { llmPlugin } from './services/llm'
export { toolsPlugin } from './services/tools'
export { agentLoopPlugin } from './services/loop'
export type { AgentLoopService, TurnResult } from './services/loop'
export { systemPromptPlugin } from './plugins/system-prompt'
export { permissionsPlugin } from './plugins/permissions'
export { toolsFsPlugin } from './plugins/tools-fs'
export { toolsShellPlugin } from './plugins/tools-shell'
export { llmOpenAICompatiblePlugin } from './plugins/llm-openai-compatible'
export { llmMockPlugin, registerMockScript, registerMockStepScript } from './plugins/llm-mock'
export { pluginLoaderPlugin, loadExternalPlugin } from './plugins/plugin-loader'
export type { ToolDefinition, ToolContext, ToolOutcome, SessionHandle } from './services/tools/types'
export type { SessionEvent, SessionEventMap, SessionEventType, TokenUsage, FileDiff } from './shared/events'
export * from './shared/types'
export { HeluoError, ConfigError, LlmError } from './shared/error'
