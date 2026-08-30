import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@cordisjs/core'
import { logger } from '../../shared/logger'
import { isSessionEvent, SESSION_EVENT_SCHEMA_VERSION, type SessionEvent } from '../../shared/events'
import type { SessionStore, CreateSessionOptions } from './store'
import { createSessionStore } from './store'

export interface SessionService {
  create(opts: CreateSessionOptions): SessionStore
  get(sessionId: string): SessionStore | undefined
  /** 从 JSONL 加载重建 store（半截尾行/坏行跳过；schemaVersion 不匹配拒绝加载）。cwd 由调用方提供（P6-1 前文件不自含 cwd）。 */
  resume(sessionId: string, cwd: string): SessionStore | undefined
}

function sessionDir(): string {
  const home = process.env.HELUO_CODE_HOME ?? join(homedir(), '.heluo-code')
  return join(home, 'sessions')
}

export function sessionPlugin(ctx: Context): void {
  const stores = new Map<string, SessionStore>()
  const dir = sessionDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    logger.warn(`session persistence unavailable (${dir}):`, err)
  }

  function persistFile(sessionId: string): string {
    return join(dir, `${sessionId}.jsonl`)
  }

  const service: SessionService = {
    create(opts) {
      const sessionId = opts.sessionId ?? randomUUID()
      const store = createSessionStore({
        sessionId,
        cwd: opts.cwd,
        initialEvents: opts.initialEvents,
        persistFile: opts.persistFile ?? persistFile(sessionId),
      })
      stores.set(store.sessionId, store)
      return store
    },
    get(sessionId: string) {
      return stores.get(sessionId)
    },
    resume(sessionId: string, cwd: string) {
      const file = persistFile(sessionId)
      let raw: string
      try {
        raw = readFileSync(file, 'utf8')
      } catch {
        logger.warn(`session resume: no log file: ${file}`)
        return undefined
      }
      const events: SessionEvent[] = []
      let rejected = false
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          logger.warn(`session resume: skipping malformed line in ${file}`)
          continue
        }
        if (!isSessionEvent(parsed)) {
          logger.warn(`session resume: skipping non-event line in ${file}`)
          continue
        }
        if (parsed.schemaVersion !== SESSION_EVENT_SCHEMA_VERSION) {
          logger.error(`session resume: schemaVersion ${parsed.schemaVersion} unsupported (expect ${SESSION_EVENT_SCHEMA_VERSION}), refusing ${file}`)
          rejected = true
          break
        }
        events.push(parsed)
      }
      if (rejected) return undefined
      const store = createSessionStore({ sessionId, cwd, initialEvents: events, persistFile: file })
      stores.set(store.sessionId, store)
      return store
    },
  }
  ctx.root.provide('sessions', service)
}
