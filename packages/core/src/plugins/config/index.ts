import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@cordisjs/core'
import { ConfigError } from '../../shared/error'
import { logger } from '../../shared/logger'
import type { DeepPartial, Profile } from '../../shared/types'
import {
  configSchema,
  type Config,
  defaultConfig,
  isPlainObject,
  loadOptional,
  mergeConfig,
} from './schema'

export interface ConfigService {
  get(): Config
  update(patch: DeepPartial<Config>): void
}

export interface ConfigPluginOptions {
  profile: Profile
  overrides?: DeepPartial<Config>
}

function formatZodError(error: unknown): string {
  if (error && typeof error === 'object' && 'issues' in error) {
    return (error as { issues: Array<{ path: (string | number)[]; message: string }> }).issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
  }
  return String(error)
}

export function assertGlobalOnly(raw: unknown, source: string): void {
  if (!isPlainObject(raw)) return
  for (const key of ['providers', 'plugins'] as const) {
    if (key in raw) {
      throw new ConfigError(`${key} 仅允许在全局配置（~/.heluo-code/config.jsonc）中声明，项目级 ${source} 不可覆盖`)
    }
  }
}

export function buildConfig(profile: Profile, overrides?: DeepPartial<Config>): Config {
  const home = process.env.HELUO_CODE_HOME ?? join(homedir(), '.heluo-code')
  const projectPath = join(profile.cwd, '.heluo-code', 'config.jsonc')
  const projectRaw = loadOptional(projectPath)
  assertGlobalOnly(projectRaw, projectPath)

  let merged: unknown = defaultConfig
  merged = mergeConfig(merged, loadOptional(join(home, 'config.jsonc')))
  merged = mergeConfig(merged, projectRaw)
  merged = mergeConfig(merged, overrides ?? {})

  const result = configSchema.safeParse(merged)
  if (!result.success) {
    throw new ConfigError(`invalid configuration: ${formatZodError(result.error)}`)
  }
  return result.data
}

export function configPlugin(ctx: Context, options: ConfigPluginOptions): void {
  let config = buildConfig(options.profile, options.overrides)
  if (!config.model) logger.warn('model 未配置：LLM 调用将失败，请在全局配置设置 model')
  ctx.root.provide('config', {
    get: () => config,
    // 内存级运行时更新（如桌面端模式切换）：不落盘 config.jsonc，
    // 作用于后续读取（permissions 每次 pre-execute 实时读 mode，即「即时生效、不追溯」）。
    update(patch: DeepPartial<Config>) {
      const merged = mergeConfig(config, patch)
      const result = configSchema.safeParse(merged)
      if (!result.success) {
        throw new ConfigError(`invalid configuration patch: ${formatZodError(result.error)}`)
      }
      config = result.data
    },
  } satisfies ConfigService)
}
