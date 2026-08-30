import { randomUUID } from 'node:crypto'
import { closeSync, openSync, writeSync } from 'node:fs'
import { logger } from '../../shared/logger'
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
  /** 关闭持久化 fd（幂等）；此后 append 不再写盘、内存继续。进程退出时 OS 亦会清理。 */
  close(): void
}

export interface CreateSessionOptions {
  sessionId?: string
  cwd: string
  /** resume 时传入已加载的历史事件 */
  initialEvents?: SessionEvent[]
  /** JSONL 落盘路径；缺省 = 纯内存（不持久化） */
  persistFile?: string
}

export function createSessionStore(opts: CreateSessionOptions): SessionStore {
  const sessionId = opts.sessionId ?? randomUUID()
  const events: SessionEvent[] = opts.initialEvents ?? []
  const listeners = new Set<(e: SessionEvent) => void>()
  const injectBuffer: string[] = []

  // 持有 fd 追加写；失败仅记日志（内存为权威，文件为持久副本，不阻断对话）
  let fd: number | null = null
  if (opts.persistFile) {
    try {
      fd = openSync(opts.persistFile, 'a')
    } catch (err) {
      logger.warn(`session persistence unavailable: ${opts.persistFile}`, err)
    }
  }

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
      if (fd !== null) {
        try {
          writeSync(fd, JSON.stringify(event) + '\n')
        } catch (err) {
          logger.error(`session append failed: ${opts.persistFile}`, err)
        }
      }
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
    close() {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch (err) {
          logger.error('session close failed', err)
        }
        fd = null
      }
    },
  }
  return store
}