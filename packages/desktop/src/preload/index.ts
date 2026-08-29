import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import {
  IPC_CHANNEL_CONFIG_GET,
  IPC_CHANNEL_CONFIG_SET,
  IPC_CHANNEL_CREDENTIALS_SET,
  IPC_CHANNEL_EVENT,
  IPC_CHANNEL_OP,
  IPC_CHANNEL_PICK_CWD,
  IPC_CHANNEL_SNAPSHOT,
} from '../shared/ipc'
import type { ConfigSnapshot, EventMsg, Op, PreloadApi, Snapshot } from '../shared/ipc'

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
  getSnapshot(): Promise<Snapshot> {
    return ipcRenderer.invoke(IPC_CHANNEL_SNAPSHOT) as Promise<Snapshot>
  },
  pickCwd(): Promise<string | null> {
    return ipcRenderer.invoke(IPC_CHANNEL_PICK_CWD) as Promise<string | null>
  },
  getConfig(): Promise<ConfigSnapshot> {
    return ipcRenderer.invoke(IPC_CHANNEL_CONFIG_GET) as Promise<ConfigSnapshot>
  },
  setConfig(patch: { model?: string; permissionMode?: 'ask' | 'agent' | 'quest' }): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNEL_CONFIG_SET, patch) as Promise<void>
  },
  setCredentials(providerId: string, apiKey: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNEL_CREDENTIALS_SET, { providerId, apiKey }) as Promise<void>
  },
}

contextBridge.exposeInMainWorld('heluo', api)