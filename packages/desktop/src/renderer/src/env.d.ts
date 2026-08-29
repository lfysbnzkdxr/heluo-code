import type { SessionEvent } from '@heluo-code/core'
import type { EventMsg, Op } from '../../shared/ipc'

declare global {
  interface Window {
    heluo: {
      submit(op: Op): void
      onEvent(cb: (msg: EventMsg) => void): () => void
      getSnapshot(): Promise<{ sessionId: string; cwd: string; events: SessionEvent[] }>
      pickCwd(): Promise<string | null>
    }
  }
}

export {}