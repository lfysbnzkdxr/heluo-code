import { configPlugin } from './plugins/config'
import type { ConfigPluginOptions } from './plugins/config'
import { createContext, shutdown, type Context as HeluoContext } from './context'
import type { DeepPartial, Profile, Config } from './shared/types'

export interface BootResult {
  ctx: HeluoContext
  shutdown(): Promise<void>
}

export async function boot(profile: Profile, overrides?: DeepPartial<Config>): Promise<BootResult> {
  const ctx = createContext()
  const options: ConfigPluginOptions = { profile, overrides }
  await ctx.plugin(configPlugin, options)
  return {
    ctx,
    shutdown: () => shutdown(ctx),
  }
}

export { createContext } from './context'
export type { Context } from './context'
export { configPlugin, buildConfig } from './plugins/config'
export type { ConfigService } from './plugins/config'
export * from './shared/types'
export { HeluoError, ConfigError } from './shared/error'
