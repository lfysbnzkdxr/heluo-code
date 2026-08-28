import type { Context } from '@cordisjs/core'
import type { SessionStore, CreateSessionOptions } from './store'
import { createSessionStore } from './store'

export interface SessionService {
  create(opts: CreateSessionOptions): SessionStore
  get(sessionId: string): SessionStore | undefined
}

export function sessionPlugin(ctx: Context): void {
  const stores = new Map<string, SessionStore>()
  const service: SessionService = {
    create(opts) {
      const store = createSessionStore({ sessionId: opts.sessionId, cwd: opts.cwd })
      stores.set(store.sessionId, store)
      return store
    },
    get(sessionId: string) {
      return stores.get(sessionId)
    },
  }
  ctx.root.provide('sessions', service)
}
