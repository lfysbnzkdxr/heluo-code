import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContext } from '../../context'
import type { ToolContext, ToolOutcome } from '../../services/tools/types'
import type { SessionEvent } from '../../shared/events'
import { toolsPlugin } from '../../services/tools'
import { toolsShellPlugin } from './index'

const TEST_TMP = (() => { const dir = join(import.meta.dirname, '..', '..', '..', '..', '..', 'test-tmp'); mkdirSync(dir, { recursive: true }); return dir })()
function makeCtx() {
  const ctx = createContext()
  ctx.provide('config', {
    get: () => ({
      model: '',
      providers: {},
      plugins: [],
      permission: { mode: 'agent' as const, questRunCommand: 'ask' as const },
      loop: { maxStepsPerTurn: 40 },
      rules: [],
      tools: {
        exclude: [],
        grepMaxResults: 100,
        outputTruncateHead: 500,
        outputTruncateTail: 500,
        runCommandMaxTimeoutMs: 60000,
        editRequiresRead: true,
      },
      sandbox: { mode: 'off' as const, writableRoots: [] },
    }),
  })
  ctx.provide('sandbox', {
    mode: 'off' as const,
    spawn(argv, opts) {
      return spawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    },
  })
  toolsPlugin(ctx)
  return ctx
}

describe('tools-shell', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(TEST_TMP, 'heluo-shell-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  function tctx(events: SessionEvent[] = [], signal?: AbortSignal): ToolContext {
    return {
      cwd,
      signal: signal ?? new AbortController().signal,
      session: {
        id: 's',
        cwd,
        inject() {},
        takeInject: () => [],
        append(type, properties) {
          const ev = { type, properties } as SessionEvent
          events.push(ev)
          return ev
        },
      },
      callId: 'call-1',
      inject() {},
    } as ToolContext
  }

  it('run_command 执行成功并实时发出 tool/stream 事件', async () => {
    const ctx = makeCtx()
    toolsShellPlugin(ctx)
    const events: SessionEvent[] = []
    const tool = ctx.tools!.get('run_command')!
    const out = (await tool.execute({ command: "Write-Output 'hello'" }, tctx(events))) as ToolOutcome
    expect(out.ok).toBe(true)
    expect((out as { outputForModel: string }).outputForModel).toContain('hello')
    expect((out as { outputForModel: string }).outputForModel).toContain('[exit code: 0]')
    const streams = events.filter((e) => e.type === 'tool/stream')
    expect(streams.length).toBeGreaterThan(0)
    const all = streams.map((e) => (e.properties as { delta: string }).delta).join('')
    expect(all).toContain('hello')
    expect(streams.every((e) => (e.properties as { callId: string }).callId === 'call-1')).toBe(true)
  })

  it('run_command 非零退出码返回错误并含输出', async () => {
    const ctx = makeCtx()
    toolsShellPlugin(ctx)
    const tool = ctx.tools!.get('run_command')!
    const out = (await tool.execute({ command: "Write-Output 'boom'; exit 3" }, tctx())) as ToolOutcome
    expect(out.ok).toBe(false)
    expect((out as { errorForModel: string }).errorForModel).toContain('退出码 3')
    expect((out as { errorForModel: string }).errorForModel).toContain('boom')
  })

  it('run_command 中文输出经 UTF-8 前缀不乱码', async () => {
    const ctx = makeCtx()
    toolsShellPlugin(ctx)
    const tool = ctx.tools!.get('run_command')!
    const out = (await tool.execute({ command: "Write-Output '你好，河洛'" }, tctx())) as ToolOutcome
    expect(out.ok).toBe(true)
    expect((out as { outputForModel: string }).outputForModel).toContain('你好，河洛')
  })

  it('run_command 超时终止进程树', async () => {
    const ctx = makeCtx()
    toolsShellPlugin(ctx)
    const tool = ctx.tools!.get('run_command')!
    const started = Date.now()
    const out = (await tool.execute({ command: 'Start-Sleep -Seconds 10', timeout_ms: 500 }, tctx())) as ToolOutcome
    expect(Date.now() - started).toBeLessThan(8000)
    expect(out.ok).toBe(false)
    expect((out as { errorForModel: string }).errorForModel).toContain('超时')
  })

  it('run_command 中断（abort）终止进程树且不挂起', async () => {
    const ctx = makeCtx()
    toolsShellPlugin(ctx)
    const ac = new AbortController()
    const tool = ctx.tools!.get('run_command')!
    const promise = tool.execute({ command: 'Start-Sleep -Seconds 10' }, tctx([], ac.signal))
    setTimeout(() => ac.abort(), 300)
    const out = (await promise) as ToolOutcome
    expect(out.ok).toBe(false)
    expect((out as { errorForModel: string }).errorForModel).toContain('取消')
  })

  it('run_command 拒绝 cwd 之外目录', async () => {
    const ctx = makeCtx()
    toolsShellPlugin(ctx)
    const tool = ctx.tools!.get('run_command')!
    const out = (await tool.execute({ command: 'Write-Output x', cwd: '/etc' }, tctx())) as ToolOutcome
    expect(out.ok).toBe(false)
  })

  it('run_command timeout_ms 超配置上限被拒绝', async () => {
    const ctx = makeCtx()
    toolsShellPlugin(ctx)
    const tool = ctx.tools!.get('run_command')!
    const out = (await tool.execute({ command: 'Write-Output x', timeout_ms: 99999999 }, tctx())) as ToolOutcome
    expect(out.ok).toBe(false)
    expect((out as { errorForModel: string }).errorForModel).toContain('上限')
  })
})
