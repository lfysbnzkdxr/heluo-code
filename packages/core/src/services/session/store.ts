import { randomUUID } from 'node:crypto'
import { SESSION_EVENT_SCHEMA_VERSION, type SessionEvent, type SessionEventMap, type SessionEventType } from '../../shared/events'
import type { SessionHandle } from '../tools/types'

export interface SessionStore extends SessionHandle {
  sessionId: string
  cwd: string
  events: SessionEvent[]
  injectBuffer: string[]
  getAll(): SessionEvent[]
  subscribe(cb: (e: SessionEvent) => void): () => void
  append<K extends SessionEventType>(type: K, properties: SessionEventMap[K]): SessionEvent
}

export interface CreateSessionOptions {
  sessionId?: string
  cwd: string
}

export function createSessionStore(opts: CreateSessionOptions): SessionStore {
  const sessionId = opts.sessionId ?? randomUUID()
  const events: SessionEvent[] = []
  const listeners = new Set<(e: SessionEvent) => void>()
  const injectBuffer: string[] = []

  const store: SessionStore = {
    id: sessionId,
    sessionId,
    cwd: opts.cwd,
    events,
    injectBuffer,
    append(type, properties) {
      const event = {
        id: randomUUID(),
        sessionId,
        schemaVersion: SESSION_EVENT_SCHEMA_VERSION,
        timestamp: Date.now(),
        type,
        properties,
      } as SessionEvent
      events.push(event)
      for (const cb of listeners) cb(event)
      return event
    },
    getAll: () => events,
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    inject(text: string) {
      injectBuffer.push(text)
    },
    takeInject(): string[] {
      const taken = injectBuffer.slice()
      injectBuffer.length = 0
      return taken
    },
  }
  return store
}
