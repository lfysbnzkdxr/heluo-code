import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { SessionEvent } from '@heluo-code/core'
import { IPC_CHANNEL_EVENT, IPC_CHANNEL_OP, IPC_CHANNEL_PICK_CWD, IPC_CHANNEL_SNAPSHOT } from '../shared/ipc'
import type { EventMsg, Op, PreloadApi } from '../shared/ipc'

// contextBridge 白名单 API（SPEC §10.2 安全基线：contextIsolation + 白名单，renderer 不接触 core）
const api: PreloadApi = {
  submit(op: Op): void {
    ipcRenderer.send(IPC_CHANNEL_OP, op)
  },
  onEvent(cb: (msg: EventMsg) => void): () => void {
    const listener = (_e: IpcRendererEvent, msg: EventMsg): void => cb(msg)
    ipcRenderer.on(IPC_CHANNEL_EVENT, listener)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNEL_EVENT, listener)
    }
  },
  getSnapshot(): Promise<{ sessionId: string; cwd: string; events: SessionEvent[] }> {
    return ipcRenderer.invoke(IPC_CHANNEL_SNAPSHOT) as Promise<{ sessionId: string; cwd: string; events: SessionEvent[] }>
  },
  pickCwd(): Promise<string | null> {
    return ipcRenderer.invoke(IPC_CHANNEL_PICK_CWD) as Promise<string | null>
  },
}

contextBridge.exposeInMainWorld('heluo', api)