import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context, SessionEvent, SessionStore } from '@heluo-code/core'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import {
  IPC_CHANNEL_CONFIG_GET,
  IPC_CHANNEL_CONFIG_SET,
  IPC_CHANNEL_CREDENTIALS_SET,
  IPC_CHANNEL_EVENT,
  IPC_CHANNEL_OP,
  IPC_CHANNEL_PICK_CWD,
  IPC_CHANNEL_SNAPSHOT,
} from '../shared/ipc'
import type { ConfigSnapshot, EventMsg, Op, SessionInfo } from '../shared/ipc'

export interface BridgeDeps {
  ctx: Context
  ipcMain: IpcMain
  webContents: WebContents
  cwd: string
  pickDirectory(): Promise<string | null>
}

export interface Bridge {
  readonly session: SessionStore
  setCwd(cwd: string): void
  dispose(): void
}

// main 侧 IPC bridge：Op 处理 + SessionEvent 转发 + 快照重同步（SPEC §10.2）。
// 多会话（P4b）：会话绑定 cwd、切换保留历史；事件仅转发 active 会话（切换不串事件）。
// 纯逻辑（不依赖 electron 运行环境），可在 vitest 中以 mock 的 ipcMain/webContents 装配测试。
export function attachBridge(deps: BridgeDeps): Bridge {
  const { ctx, ipcMain, webContents } = deps

  const sessions = new Map<string, SessionStore>()
  let activeId: string
  let unsubscribe: () => void = () => {}
  let disposed = false

  function sessionList(): SessionInfo[] {
    return [...sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd, active: s.id === activeId }))
  }

  function broadcast(msg: EventMsg): void {
    if (!disposed && !webContents.isDestroyed()) webContents.send(IPC_CHANNEL_EVENT, msg)
  }

  function broadcastSessions(): void {
    broadcast({ type: 'sessions-changed', sessions: sessionList() })
  }

  function subscribeToSession(): void {
    const session = sessions.get(activeId)!
    unsubscribe = session.subscribe((ev: SessionEvent) => {
      broadcast({ type: 'session-event', event: ev })
    })
  }

  function createSession(cwd: string): SessionStore {
    const session = ctx.agentLoop!.createSession(cwd)
    sessions.set(session.id, session)
    return session
  }

  function activate(sessionId: string): void {
    if (!sessions.has(sessionId) || sessionId === activeId) return
    unsubscribe()
    activeId = sessionId
    subscribeToSession()
    broadcastSessions()
  }

  const onOp = (_e: unknown, op: Op): void => {
    if (disposed) return
    switch (op.type) {
      case 'user-turn': {
        const session = sessions.get(op.sessionId)
        if (!session) return
        void ctx.agentLoop!.openTurn({ session, text: op.text })
        break
      }
      case 'interrupt': {
        ctx.agentLoop!.interrupt(op.sessionId)
        break
      }
      case 'permission-decision': {
        ctx.permissions!.respond(op.requestId, op.decision)
        break
      }
      case 'create-session': {
        const current = sessions.get(activeId)!
        const created = createSession(current.cwd)
        unsubscribe()
        activeId = created.id
        subscribeToSession()
        broadcastSessions()
        break
      }
      case 'switch-session': {
        activate(op.sessionId)
        break
      }
    }
  }
  ipcMain.on(IPC_CHANNEL_OP, onOp)

  const onSnapshot = (_e: IpcMainInvokeEvent) => {
    const session = sessions.get(activeId)!
    return { sessionId: session.id, cwd: session.cwd, events: session.getAll(), sessions: sessionList() }
  }
  ipcMain.handle(IPC_CHANNEL_SNAPSHOT, onSnapshot)

  const onPickCwd = async (): Promise<string | null> => {
    const picked = await deps.pickDirectory()
    if (picked) setCwd(picked)
    return picked
  }
  ipcMain.handle(IPC_CHANNEL_PICK_CWD, onPickCwd)

  function configSnapshot(): ConfigSnapshot {
    const config = ctx.root.config?.get()
    return {
      model: config?.model ?? '',
      providers: Object.entries(config?.providers ?? {}).map(([id, p]) => ({ id, type: p.type, baseURL: p.baseURL, models: p.models })),
      permissionMode: config?.permission.mode ?? 'agent',
    }
  }
  const onConfigGet = (): ConfigSnapshot => configSnapshot()
  ipcMain.handle(IPC_CHANNEL_CONFIG_GET, onConfigGet)

  const onConfigSet = (_e: IpcMainInvokeEvent, patch: { model?: string; permissionMode?: 'ask' | 'agent' | 'quest' }): void => {
    const config = ctx.root.config
    if (!config) throw new Error('config service 未挂载')
    // 安全边界：仅允许 UI 可改项（model/permission.mode）；providers/plugins 全局字段拒绝（specs/config.md）
    const { model, permissionMode } = patch ?? {}
    const update: Record<string, unknown> = {}
    if (typeof model === 'string') update.model = model
    if (permissionMode !== undefined) {
      if (permissionMode !== 'ask' && permissionMode !== 'agent' && permissionMode !== 'quest') {
        throw new Error(`config-set: 非法 permissionMode ${String(permissionMode)}`)
      }
      update.permission = { mode: permissionMode }
    }
    config.update(update)
  }
  ipcMain.handle(IPC_CHANNEL_CONFIG_SET, onConfigSet)

  const onSetCredentials = (_e: IpcMainInvokeEvent, body: { providerId?: unknown; apiKey?: unknown }): void => {
    const { providerId, apiKey } = body ?? {}
    if (typeof providerId !== 'string' || providerId.length === 0 || typeof apiKey !== 'string') {
      throw new Error('set-credentials: providerId 与 apiKey 必须为字符串')
    }
    writeCredentials(providerId, apiKey)
  }
  ipcMain.handle(IPC_CHANNEL_CREDENTIALS_SET, onSetCredentials)

  function setCwd(cwd: string): void {
    // 更换 cwd = 新建会话（绑定新 cwd）并激活；旧会话保留历史（P4b 语义）
    const created = createSession(cwd)
    unsubscribe()
    activeId = created.id
    subscribeToSession()
    broadcast({ type: 'cwd-changed', cwd })
    broadcastSessions()
  }

  const initial = createSession(deps.cwd)
  activeId = initial.id
  subscribeToSession()

  const bridge: Bridge = {
    get session() {
      return sessions.get(activeId)!
    },
    setCwd,
    dispose() {
      disposed = true
      ipcMain.removeListener(IPC_CHANNEL_OP, onOp)
      ipcMain.removeHandler(IPC_CHANNEL_SNAPSHOT)
      ipcMain.removeHandler(IPC_CHANNEL_PICK_CWD)
      ipcMain.removeHandler(IPC_CHANNEL_CONFIG_GET)
      ipcMain.removeHandler(IPC_CHANNEL_CONFIG_SET)
      ipcMain.removeHandler(IPC_CHANNEL_CREDENTIALS_SET)
      unsubscribe()
    },
  }

  return bridge
}

// 凭据写盘：~/.heluo-code/credentials.json（JSON：{ providerId: apiKey }，0600）。
// renderer 不接触 apiKey（桌面安全基线 R5）：设置页仅经此 IPC 交 main 落盘。
export function writeCredentials(providerId: string, apiKey: string): void {
  const home = process.env.HELUO_CODE_HOME ?? join(homedir(), '.heluo-code')
  const path = join(home, 'credentials.json')
  let existing: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    }
  } catch {
    /* 文件不存在或损坏：重建 */
  }
  const next = { ...existing, [providerId]: apiKey }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
}