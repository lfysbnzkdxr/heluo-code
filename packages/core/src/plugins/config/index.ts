import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@cordisjs/core'
import { ConfigError } from '../../shared/error'
import type { DeepPartial, Profile } from '../../shared/types'
import {
  configSchema,
  type Config,
  defaultConfig,
  loadOptional,
  mergeConfig,
} from './schema'

export interface ConfigService {
  get(): Config
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

export function buildConfig(profile: Profile, overrides?: DeepPartial<Config>): Config {
  const home = process.env.HELUO_CODE_HOME ?? join(homedir(), '.heluo-code')
  let merged: unknown = defaultConfig
  merged = mergeConfig(merged, loadOptional(join(home, 'config.jsonc')))
  merged = mergeConfig(merged, loadOptional(join(profile.cwd, '.heluo-code', 'config.jsonc')))
  merged = mergeConfig(merged, overrides ?? {})

  const result = configSchema.safeParse(merged)
  if (!result.success) {
    throw new ConfigError(`invalid configuration: ${formatZodError(result.error)}`)
  }
  return result.data
}

export function configPlugin(ctx: Context, options: ConfigPluginOptions): void {
  const config = buildConfig(options.profile, options.overrides)
  ctx.provide('config', { get: () => config } satisfies ConfigService)
}
