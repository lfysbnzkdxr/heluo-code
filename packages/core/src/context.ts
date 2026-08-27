import { Context } from '@cordisjs/core'
import type { ConfigService } from './plugins/config'

declare module '@cordisjs/core' {
  interface Context {
    config?: ConfigService
  }
}

export type { Context }

export function createContext(): Context {
  return new Context()
}

export async function shutdown(ctx: Context): Promise<void> {
  await ctx.fiber?.dispose()
}
