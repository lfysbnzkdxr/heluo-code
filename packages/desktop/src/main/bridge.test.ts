import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IpcMain, WebContents } from 'electron'
import { boot, llmMockPlugin, registerMockScript } from '@heluo-code/core'
import type { SessionEvent } from '@heluo-code/core'
import { attachBridge } from './bridge'
import type { EventMsg, Op } from '../shared/ipc'
import { IPC_CHANNEL_EVENT, IPC_CHANNEL_OP, IPC_CHANNEL_PICK_CWD, IPC_CHANNEL_SNAPSHOT } from '../shared/ipc'

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

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'heluo-bridge-'))
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
    const next = mkdtempSync(join(tmpdir(), 'heluo-bridge2-'))
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
})