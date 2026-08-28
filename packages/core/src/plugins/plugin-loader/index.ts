import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context, Plugin } from '@cordisjs/core'
import { logger } from '../../shared/logger'
import type { Profile } from '../../shared/types'

export interface PluginLoaderOptions {
  profile: Profile
}

// 外部插件模块：ESM 默认导出或具名导出；插件形态见 SPEC §5.5（与 Cordis 插件一致）
export async function loadExternalPlugin(ctx: Context, spec: string, cwd: string): Promise<void> {
  let mod: unknown
  try {
    if (isAbsolute(spec) || spec.startsWith('.')) {
      mod = await import(pathToFileURL(resolve(cwd, spec)).href)
    } else {
      mod = await import(spec)
    }
  } catch (error) {
    logger.error(`外部插件加载失败（import）: ${spec}`, error instanceof Error ? error.message : String(error))
    return
  }
  const candidate = (mod as { default?: unknown }).default ?? mod
  const plugin = candidate as Plugin
  try {
    await ctx.plugin(plugin)
    logger.info(`外部插件已挂载: ${spec}`)
  } catch (error) {
    logger.error(`外部插件挂载失败: ${spec}`, error instanceof Error ? error.message : String(error))
  }
}

export async function pluginLoaderPlugin(ctx: Context, options: PluginLoaderOptions): Promise<void> {
  const config = ctx.root.config?.get()
  if (!config) return
  for (const spec of config.plugins) {
    await loadExternalPlugin(ctx, spec, options.profile.cwd)
  }
}

void Object.assign(pluginLoaderPlugin, { inject: ['config'] })