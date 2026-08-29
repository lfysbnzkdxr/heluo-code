import type { Context, SessionEvent, SessionStore } from '@heluo-code/core'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { IPC_CHANNEL_EVENT, IPC_CHANNEL_OP, IPC_CHANNEL_PICK_CWD, IPC_CHANNEL_SNAPSHOT } from '../shared/ipc'
import type { EventMsg, Op } from '../shared/ipc'

export interface BridgeDeps {
  ctx: Context
  ipcMain: IpcMain
  webContents: WebContents
  cwd: string
  pickDirectory(): Promise<string | null>
}

export interface Bridge {
  session: SessionStore
  setCwd(cwd: string): void
  dispose(): void
}

// main 侧 IPC bridge：Op 处理 + SessionEvent 转发 + 快照重同步（SPEC §10.2）。
// 纯逻辑（不依赖 electron 运行环境），可在 vitest 中以 mock 的 ipcMain/webContents 装配测试。
export function attachBridge(deps: BridgeDeps): Bridge {
  const { ctx, ipcMain, webContents } = deps

  let session: SessionStore = ctx.agentLoop!.createSession(deps.cwd)
  let unsubscribe: () => void = () => {}
  let disposed = false

  function broadcast(msg: EventMsg): void {
    if (!disposed && !webContents.isDestroyed()) webContents.send(IPC_CHANNEL_EVENT, msg)
  }

  function subscribeToSession(): void {
    unsubscribe = session.subscribe((ev: SessionEvent) => {
      broadcast({ type: 'session-event', event: ev })
    })
  }

  const onOp = (_e: unknown, op: Op): void => {
    if (disposed) return
    switch (op.type) {
      case 'user-turn': {
        if (op.sessionId !== session.id) return // 单会话：不匹配的 sessionId 忽略（P4b 多会话再扩）
        void ctx.agentLoop!.openTurn({ session, text: op.text })
        break
      }
      case 'interrupt': {
        if (op.sessionId !== session.id) return
        ctx.agentLoop!.interrupt(session.id)
        break
      }
      case 'permission-decision': {
        ctx.permissions!.respond(op.requestId, op.decision)
        break
      }
    }
  }
  ipcMain.on(IPC_CHANNEL_OP, onOp)

  const onSnapshot = (_e: IpcMainInvokeEvent): { sessionId: string; cwd: string; events: SessionEvent[] } => ({
    sessionId: session.id,
    cwd: session.cwd,
    events: session.getAll(),
  })
  ipcMain.handle(IPC_CHANNEL_SNAPSHOT, onSnapshot)

  const onPickCwd = async (): Promise<string | null> => {
    const picked = await deps.pickDirectory()
    if (picked) setCwd(picked)
    return picked
  }
  ipcMain.handle(IPC_CHANNEL_PICK_CWD, onPickCwd)

  function setCwd(cwd: string): void {
    unsubscribe()
    session = ctx.agentLoop!.createSession(cwd)
    subscribeToSession()
    broadcast({ type: 'cwd-changed', cwd })
  }

  subscribeToSession()

  const bridge: Bridge = {
    session,
    setCwd,
    dispose() {
      disposed = true
      ipcMain.removeListener(IPC_CHANNEL_OP, onOp)
      ipcMain.removeHandler(IPC_CHANNEL_SNAPSHOT)
      ipcMain.removeHandler(IPC_CHANNEL_PICK_CWD)
      unsubscribe()
    },
  }

  return bridge
}