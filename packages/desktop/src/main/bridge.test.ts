import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IpcMain, WebContents } from 'electron'
import { boot, llmMockPlugin, registerMockScript } from '@heluo-code/core'
import type { SessionEvent } from '@heluo-code/core'
import { attachBridge, writeCredentials } from './bridge'
import type { AgentInfo, EventMsg, Op, Snapshot } from '../shared/ipc'
import {
  IPC_CHANNEL_CONFIG_GET,
  IPC_CHANNEL_CONFIG_SET,
  IPC_CHANNEL_CREDENTIALS_SET,
  IPC_CHANNEL_EVENT,
  IPC_CHANNEL_OP,
  IPC_CHANNEL_PICK_CWD,
  IPC_CHANNEL_SNAPSHOT,
} from '../shared/ipc'

const TEST_TMP = (() => { const dir = join(import.meta.dirname, '..', '..', '..', '..', 'test-tmp'); mkdirSync(dir, { recursive: true }); return dir })()
type Listener = (e: unknown, ...args: unknown[]) => void

function mockIpcMain(): { ipcMain: IpcMain; fireOp: (op: Op) => void; invoke: (channel: string, ...args: unknown[]) => Promise<unknown>; fired: string[] } {
  const listeners = new Map<string, Listener>()
  const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()
  const fired: string[] = []
  return {
    ipcMain: {
      on: (ch: string, fn: Listener) => {
        listeners.set(ch, fn)
      },
      handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(ch, fn)
      },
      removeListener: (ch: string) => {
        listeners.delete(ch)
        fired.push(`removeListener:${ch}`)
      },
      removeHandler: (ch: string) => {
        handlers.delete(ch)
        fired.push(`removeHandler:${ch}`)
      },
    } as unknown as IpcMain,
    fireOp: (op: Op) => {
      const fn = listeners.get(IPC_CHANNEL_OP)
      if (!fn) throw new Error('no op listener')
      fn(null, op)
    },
    invoke: async (ch: string, ...args: unknown[]) => {
      const fn = handlers.get(ch)
      if (!fn) throw new Error(`no handler for ${ch}`)
      return fn(null, ...args)
    },
    fired,
  }
}

function mockWebContents(): { webContents: WebContents; sent: EventMsg[] } {
  const sent: EventMsg[] = []
  return {
    webContents: {
      send: (ch: string, msg: EventMsg) => {
        if (ch === IPC_CHANNEL_EVENT) sent.push(msg)
      },
      isDestroyed: () => false,
    } as unknown as WebContents,
    sent,
  }
}

async function waitFor(pred: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('main bridge', () => {
  let base: string
  let app: Awaited<ReturnType<typeof boot>>
  let ipc: ReturnType<typeof mockIpcMain>
  let wc: ReturnType<typeof mockWebContents>
  const prevHome = process.env.HELUO_CODE_HOME

  beforeEach(async () => {
    base = mkdtempSync(join(TEST_TMP, 'heluo-bridge-'))
    process.env.HELUO_CODE_HOME = join(base, 'home')
    mkdirSync(process.env.HELUO_CODE_HOME!, { recursive: true })
    app = await boot(
      { cwd: base },
      {
        model: 'mock/bridge',
        providers: { mock: { type: 'mock' } },
        permission: { mode: 'agent' },
      },
    )
    await app.ctx.plugin(llmMockPlugin)
    registerMockScript('bridge', [{ type: 'text-delta', delta: '你好' }, { type: 'done' }])
    ipc = mockIpcMain()
    wc = mockWebContents()
  })

  afterEach(async () => {
    await app.shutdown()
    rmSync(base, { recursive: true, force: true })
    if (prevHome === undefined) delete process.env.HELUO_CODE_HOME
    else process.env.HELUO_CODE_HOME = prevHome
  })

  function attach(): ReturnType<typeof attachBridge> {
    return attachBridge({ ctx: app.ctx, ipcMain: ipc.ipcMain, webContents: wc.webContents, cwd: base, pickDirectory: async () => null })
  }

  function events(): SessionEvent[] {
    return wc.sent.filter((m) => m.type === 'session-event').map((m) => (m as { event: SessionEvent }).event)
  }

  it('user-turn op 驱动一次完整 turn，事件流转发到 renderer', async () => {
    const bridge = attach()
    ipc.fireOp({ type: 'user-turn', sessionId: bridge.session.id, text: '说你好' })
    await waitFor(() => events().some((e) => e.type === 'turn/end'))

    const evs = events()
    expect(evs[0]!.type).toBe('turn/start')
    expect(evs.some((e) => e.type === 'assistant/message' && e.properties.content === '你好')).toBe(true)
    const end = evs.find((e) => e.type === 'turn/end')!
    expect(end.properties.stopReason).toBe('completed')
    bridge.dispose()
  })

  it('权限流：request 事件到达 → permission-decision op 响应 → 工具执行结果', async () => {
    registerMockScript('bridge', [
      { type: 'text-delta', delta: '写文件' },
      { type: 'tool-call', call: { id: 'c1', name: 'write_file', argsJson: JSON.stringify({ path: 'a.txt', content: 'x' }) } },
      { type: 'done' },
    ])
    const bridge = attach()

    const turn = app.ctx.agentLoop!.openTurn({ session: bridge.session, text: '写个文件' })
    await waitFor(() => events().some((e) => e.type === 'permission/request'))
    const req = events().find((e) => e.type === 'permission/request')!
    expect(req.properties.tool).toBe('write_file')

    ipc.fireOp({ type: 'permission-decision', requestId: req.properties.id, decision: 'always' })
    const result = await turn
    expect(result.stopReason).toBe('completed')
    const res = events().find((e) => e.type === 'permission/response')!
    expect(res.properties.decision).toBe('always')
    expect(events().some((e) => e.type === 'tool/result' && !e.properties.isError)).toBe(true)
    bridge.dispose()
  })

  it('interrupt op 中断进行中 turn', async () => {
    const bridge = attach()
    const turn = app.ctx.agentLoop!.openTurn({ session: bridge.session, text: '任务' })
    ipc.fireOp({ type: 'interrupt', sessionId: bridge.session.id })
    const result = await turn
    expect(result.stopReason).toBe('interrupted')
    const end = events().find((e) => e.type === 'turn/end')!
    expect(end.properties.stopReason).toBe('interrupted')
    bridge.dispose()
  })

  it('快照 handler 返回全量会话日志（刷新重同步）', async () => {
    const bridge = attach()
    ipc.fireOp({ type: 'user-turn', sessionId: bridge.session.id, text: '说你好' })
    await waitFor(() => events().some((e) => e.type === 'turn/end'))

    const snapshot = (await ipc.invoke(IPC_CHANNEL_SNAPSHOT)) as { sessionId: string; cwd: string; events: SessionEvent[] }
    expect(snapshot.sessionId).toBe(bridge.session.id)
    expect(snapshot.cwd).toBe(base)
    expect(snapshot.events).toEqual(bridge.session.getAll())
    expect(snapshot.events[0]!.type).toBe('turn/start')
    bridge.dispose()
  })

  it('pick-cwd 换目录：广播 cwd-changed，新会话快照为空', async () => {
    const next = mkdtempSync(join(TEST_TMP, 'heluo-bridge2-'))
    const bridge = attachBridge({
      ctx: app.ctx,
      ipcMain: ipc.ipcMain,
      webContents: wc.webContents,
      cwd: base,
      pickDirectory: async () => next,
    })
    const picked = (await ipc.invoke(IPC_CHANNEL_PICK_CWD)) as string | null
    expect(picked).toBe(next)
    expect(wc.sent.some((m) => m.type === 'cwd-changed' && m.cwd === next)).toBe(true)
    const snapshot = (await ipc.invoke(IPC_CHANNEL_SNAPSHOT)) as { sessionId: string; cwd: string; events: SessionEvent[] }
    expect(snapshot.cwd).toBe(next)
    expect(snapshot.events).toEqual([])
    rmSync(next, { recursive: true, force: true })
    bridge.dispose()
  })

  it('dispose 后：监听移除、事件不再转发', async () => {
    const bridge = attach()
    ipc.fireOp({ type: 'user-turn', sessionId: bridge.session.id, text: '说你好' })
    await waitFor(() => events().some((e) => e.type === 'turn/end'))
    const countBefore = wc.sent.length

    bridge.dispose()
    expect(ipc.fired).toContain(`removeListener:${IPC_CHANNEL_OP}`)
    expect(ipc.fired).toContain(`removeHandler:${IPC_CHANNEL_SNAPSHOT}`)
    expect(ipc.fired).toContain(`removeHandler:${IPC_CHANNEL_PICK_CWD}`)
    expect(() => ipc.fireOp({ type: 'user-turn', sessionId: bridge.session.id, text: '不应处理' })).toThrow('no op listener')
    await new Promise((r) => setTimeout(r, 50))
    expect(wc.sent.length).toBe(countBefore)
  })

  it('config-get 返回模型/provider 列表/权限模式快照', async () => {
    const bridge = attach()
    const cfg = (await ipc.invoke(IPC_CHANNEL_CONFIG_GET)) as {
      model: string
      providers: Array<{ id: string; type: string }>
      permissionMode: string
    }
    expect(cfg.model).toBe('mock/bridge')
    expect(cfg.providers).toEqual([{ id: 'mock', type: 'mock', baseURL: undefined, models: undefined }])
    expect(cfg.permissionMode).toBe('agent')
    bridge.dispose()
  })

  it('config-set 更新模型与权限模式（即时生效）；非法模式被拒', async () => {
    const bridge = attach()
    await ipc.invoke(IPC_CHANNEL_CONFIG_SET, { model: 'mock/other', permissionMode: 'quest' })
    expect(app.ctx.config!.get().model).toBe('mock/other')
    expect(app.ctx.config!.get().permission.mode).toBe('quest')

    await expect(ipc.invoke(IPC_CHANNEL_CONFIG_SET, { permissionMode: 'hack' })).rejects.toThrow()
    expect(app.ctx.config!.get().permission.mode).toBe('quest')
    bridge.dispose()
  })

  it('credentials-set 写 ~/.heluo-code/credentials.json（含父目录创建）', async () => {
    const bridge = attach()
    await ipc.invoke(IPC_CHANNEL_CREDENTIALS_SET, { providerId: 'deepseek', apiKey: 'sk-123' })
    const path = join(process.env.HELUO_CODE_HOME!, 'credentials.json')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ deepseek: 'sk-123' })

    // 再次写入合并而非覆盖
    await ipc.invoke(IPC_CHANNEL_CREDENTIALS_SET, { providerId: 'qwen', apiKey: 'sk-456' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ deepseek: 'sk-123', qwen: 'sk-456' })
    bridge.dispose()
  })

  it('credentials-set 参数非法时拒绝', async () => {
    const bridge = attach()
    await expect(ipc.invoke(IPC_CHANNEL_CREDENTIALS_SET, { providerId: '', apiKey: 'x' })).rejects.toThrow()
    await expect(ipc.invoke(IPC_CHANNEL_CREDENTIALS_SET, { providerId: 'x', apiKey: 42 })).rejects.toThrow()
    bridge.dispose()
  })

  it('writeCredentials 保留既有文件内容（损坏文件重建）', () => {
    const path = join(process.env.HELUO_CODE_HOME!, 'credentials.json')
    writeCredentials('a', '1')
    writeCredentials('b', '2')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: '1', b: '2' })

    writeFileSync(path, '{ 损坏')
    writeCredentials('c', '3')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ c: '3' })
  })

  it('create-session 新建同 cwd 会话并激活（旧会话保留历史）', async () => {
    const bridge = attach()
    ipc.fireOp({ type: 'user-turn', sessionId: bridge.session.id, text: '说你好' })
    await waitFor(() => events().some((e) => e.type === 'turn/end'))
    const firstId = bridge.session.id

    ipc.fireOp({ type: 'create-session' })
    await waitFor(() => wc.sent.some((m) => m.type === 'sessions-changed'))
    const snapshot = (await ipc.invoke(IPC_CHANNEL_SNAPSHOT)) as {
      sessionId: string
      cwd: string
      events: SessionEvent[]
      sessions: Array<{ id: string; cwd: string; active: boolean }>
    }
    expect(snapshot.sessionId).not.toBe(firstId)
    expect(snapshot.events).toEqual([])
    expect(snapshot.sessions).toHaveLength(2)
    expect(snapshot.sessions.filter((s) => s.active)).toHaveLength(1)
    expect(snapshot.sessions[1]!.cwd).toBe(base)
    bridge.dispose()
  })

  it('switch-session 切回旧会话：快照恢复历史、激活态正确', async () => {
    const bridge = attach()
    ipc.fireOp({ type: 'user-turn', sessionId: bridge.session.id, text: '说你好' })
    await waitFor(() => events().some((e) => e.type === 'turn/end'))
    const firstId = bridge.session.id

    ipc.fireOp({ type: 'create-session' })
    await waitFor(() => wc.sent.some((m) => m.type === 'sessions-changed'))
    wc.sent.length = 0

    ipc.fireOp({ type: 'switch-session', sessionId: firstId })
    await waitFor(() => wc.sent.some((m) => m.type === 'sessions-changed'))
    const snapshot = (await ipc.invoke(IPC_CHANNEL_SNAPSHOT)) as {
      sessionId: string
      events: SessionEvent[]
      sessions: Array<{ id: string; active: boolean }>
    }
    expect(snapshot.sessionId).toBe(firstId)
    expect(snapshot.events.some((e) => e.type === 'assistant/message')).toBe(true)
    expect(snapshot.sessions.find((s) => s.id === firstId)!.active).toBe(true)
    bridge.dispose()
  })

  it('非 active 会话 turn 不串入当前 UI 事件流；切回后历史完整', async () => {
    const bridge = attach()
    const firstId = bridge.session.id
    ipc.fireOp({ type: 'create-session' })
    await waitFor(() => wc.sent.some((m) => m.type === 'sessions-changed'))

    // 对非 active 会话发起 turn：事件落日志但不转发（事件流只含 active 会话）
    ipc.fireOp({ type: 'user-turn', sessionId: firstId, text: '说你好' })
    await waitFor(() => !app.ctx.agentLoop!.hasActiveTurns())
    expect(events().some((e) => e.type === 'assistant/message')).toBe(false)

    // 切回后快照含该 turn 完整历史
    ipc.fireOp({ type: 'switch-session', sessionId: firstId })
    await waitFor(() => wc.sent.some((m) => m.type === 'sessions-changed'))
    const snapshot = (await ipc.invoke(IPC_CHANNEL_SNAPSHOT)) as { events: SessionEvent[] }
    expect(snapshot.events.some((e) => e.type === 'turn/end')).toBe(true)
    bridge.dispose()
  })

  it('agents-status：子 agent 创建与状态流转全量推送（含摘要）', async () => {
    const bridge = attach()
    app.ctx.agents!.registerDefinition({ id: 'sub', systemPrompt: 's', model: 'mock/sub' })
    registerMockScript('sub', [{ type: 'text-delta', delta: '结论' }, { type: 'done' }])

    const h = await app.ctx.agents!.create({ task: '探索', definitionId: 'sub', parentSessionId: bridge.session.id })
    await h.waitDone()

    const msgs = wc.sent.filter((m) => m.type === 'agents-status')
    expect(msgs.length).toBeGreaterThan(0)
    const last = msgs.at(-1)! as { agents: AgentInfo[] }
    expect(last.agents).toHaveLength(1)
    expect(last.agents[0]!.status).toBe('done')
    expect(last.agents[0]!.summary).toBe('结论')
    bridge.dispose()
  })

  it('agent-interrupt op 中断在途子 agent（子会话 interrupted 闭合）', async () => {
    const bridge = attach()
    app.ctx.agents!.registerDefinition({ id: 'subw', systemPrompt: 'w', model: 'mock/subw', tools: ['write_file'] })
    registerMockScript('subw', [
      { type: 'tool-call', call: { id: 'w1', name: 'write_file', argsJson: JSON.stringify({ path: 'a.txt', content: 'x' }) } },
      { type: 'done' },
    ])

    const h = await app.ctx.agents!.create({ task: '写文件', definitionId: 'subw', parentSessionId: bridge.session.id })
    await waitFor(() => h.status === 'waiting-permission')
    ipc.fireOp({ type: 'agent-interrupt', agentId: h.id })
    await h.waitDone()

    const child = app.ctx.sessions!.get(h.sessionId)!
    const end = child.getAll().find((e) => e.type === 'turn/end')!
    expect(end.properties.stopReason).toBe('interrupted')
    bridge.dispose()
  })

  it('快照携带 agents 列表（刷新重同步恢复看板）', async () => {
    const bridge = attach()
    app.ctx.agents!.registerDefinition({ id: 'sub3', systemPrompt: 's', model: 'mock/sub3' })
    registerMockScript('sub3', [{ type: 'text-delta', delta: 'x' }, { type: 'done' }])

    const h = await app.ctx.agents!.create({ task: 't', definitionId: 'sub3', parentSessionId: bridge.session.id })
    await h.waitDone()

    const snap = (await ipc.invoke(IPC_CHANNEL_SNAPSHOT)) as Snapshot
    expect(snap.agents).toHaveLength(1)
    expect(snap.agents[0]!.task).toBe('t')
    expect(snap.agents[0]!.status).toBe('done')
    bridge.dispose()
  })
})
