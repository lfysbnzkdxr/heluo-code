import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContext } from '../../context'
import { toolsPlugin } from '../../services/tools'
import type { ToolContext } from '../../services/tools/types'
import { sandboxPlugin, type SandboxService } from './index'
import { toolsShellPlugin } from '../tools-shell'

const TEST_TMP = (() => { const dir = join(import.meta.dirname, '..', '..', '..', '..', '..', 'test-tmp'); mkdirSync(dir, { recursive: true }); return dir })()

const isWin32 = process.platform === 'win32'
const describeWin = isWin32 ? describe : describe.skip

function makeCtx(overrides: Record<string, unknown> = {}) {
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
      sandbox: { mode: 'restricted-write' as const, writableRoots: [] },
      ...overrides,
    }),
  })
  sandboxPlugin(ctx)
  toolsPlugin(ctx)
  return ctx
}

describe('sandbox 服务（模式解析）', () => {
  it('非 win32 强制 off 并 warn', () => {
    const ctx = createContext()
    ctx.provide('config', { get: () => ({ sandbox: { mode: 'restricted-write', writableRoots: [] } }) })
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    sandboxPlugin(ctx)
    Object.defineProperty(process, 'platform', { value: original })
    expect(ctx.root.sandbox!.mode).toBe('off')
  })

  it('isolated 映射 restricted-write（P6-0b 前网络隔离未落地）', () => {
    const ctx = makeCtx({ sandbox: { mode: 'isolated', writableRoots: [] } })
    expect(ctx.root.sandbox!.mode).toBe('restricted-write')
  })

  it('Electron 环境 restricted-write/isolated 降级 job（受限子进程控制台分配失败 0xC0000142）', () => {
    const original = process.versions.electron
    Object.defineProperty(process.versions, 'electron', { value: '44.0.0', configurable: true })
    try {
      const ctx1 = makeCtx({ sandbox: { mode: 'restricted-write', writableRoots: [] } })
      expect(ctx1.root.sandbox!.mode).toBe('job')
      const ctx2 = makeCtx({ sandbox: { mode: 'isolated', writableRoots: [] } })
      expect(ctx2.root.sandbox!.mode).toBe('job')
    } finally {
      if (original === undefined) delete process.versions.electron
      else Object.defineProperty(process.versions, 'electron', { value: original, configurable: true })
    }
  })

  it('spawn 参数构造：off 透传 / 沙箱走 runner', () => {
    const ctx = makeCtx()
    const service = ctx.root.sandbox as SandboxService
    const child = service.spawn(['cmd.exe', '/c', 'echo hi'], { cwd: process.cwd(), writableRoots: ['D:\\cache'] })
    // runner 模式：子进程是 node（runner 入口），非直接 cmd
    const argv = (child as { spawnargs?: string[] }).spawnargs ?? []
    expect(argv.join(' ')).toContain('runner.mjs')
    expect(argv.join(' ')).toContain('--mode restricted')
    expect(argv.join(' ')).toContain('--workspace')
    expect(argv.join(' ')).toContain('--writable-root D:\\cache')
    child.kill()
  })
})

describeWin('sandbox runner 集成（真实 Win32 进程）', () => {
  let cwd: string
  let outside: string
  beforeEach(() => {
    cwd = mkdtempSync(join(TEST_TMP, 'heluo-sandbox-'))
    outside = mkdtempSync(join(TEST_TMP, 'heluo-sandbox-out-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  function runTool(command: string, ctx = makeCtx()): Promise<{ ok: boolean; output: string }> {
    toolsShellPlugin(ctx)
    const tool = ctx.root.tools!.get!('run_command')!
    const tctx = {
      cwd,
      signal: new AbortController().signal,
      session: { append() {} },
      callId: 'c1',
    } as unknown as ToolContext
    return tool!.execute({ command, timeout_ms: 30000 }, tctx).then((r) => ({
      ok: r.ok,
      output: (r.ok ? r.outputForModel : r.errorForModel) ?? '',
    }))
  }

  it('restricted-write：写 cwd 内成功；写 cwd 外被 OS 拒绝', async () => {
    const ctx = makeCtx()
    const inside = await runTool(`Set-Content -Path "${join(cwd, 'in.txt')}" -Value "data" -Encoding UTF8`, ctx)
    expect(inside.ok).toBe(true)
    expect(existsSync(join(cwd, 'in.txt'))).toBe(true)

    const outsideFile = join(outside, 'x.txt')
    const denied = await runTool(`try { Set-Content -Path "${outsideFile}" -Value "data" -ErrorAction Stop; "OK" } catch { "DENIED" }`, ctx)
    expect(denied.output).toContain('DENIED')
    expect(existsSync(outsideFile)).toBe(false)
  })

  it('job 模式：退出码透传 + KILL_ON_JOB_CLOSE 进程树必杀', async () => {
    const ctx = makeCtx({ sandbox: { mode: 'job', writableRoots: [] } })
    // 退出码透传
    const exit3 = await runTool('exit 3', ctx)
    expect(exit3.ok).toBe(false)
    expect(exit3.output).toContain('退出码 3')

    // 进程树必杀：命令派生孙进程（写 pid 到文件），runner 退出 → job close → 孙进程被 OS 终止
    const pidFile = join(cwd, 'child.pid')
    const spawnChild = await runTool(
      `$p = Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile","-Command","Start-Sleep 60" -WindowStyle Hidden -PassThru; Set-Content -Path "${pidFile}" -Value $p.Id; "OK"`,
      ctx,
    )
    expect(spawnChild.ok).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    const alive = spawn('powershell.exe', ['-NoProfile', '-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { "ALIVE" } else { "DEAD" }`], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    alive.stdout?.on('data', (c: Buffer) => chunks.push(c))
    const result = await new Promise<string>((resolve) => alive.on('close', () => resolve(Buffer.concat(chunks).toString())))
    expect(result.trim()).toBe('DEAD')
  })

  it('fail-closed：runner 初始化失败拒绝执行（127 + sandbox-run 前缀）', async () => {
    // 直接驱动 runner（模拟 sandbox 服务内部失败）：非法 --mode → parseArgs fail → 127 + sandbox-run: 前缀
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, '..', '..', '..', 'sandbox', 'runner.mjs'), '--mode', 'bogus', '--workspace', cwd, '--', 'cmd.exe', '/c', 'echo hi'],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const chunks: Buffer[] = []
    child.stdout?.on('data', (c: Buffer) => chunks.push(c))
    child.stderr?.on('data', (c: Buffer) => chunks.push(c))
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('close', resolve)
      child.on('error', () => resolve(-1))
    })
    const output = Buffer.concat(chunks).toString()
    expect(exitCode).toBe(127)
    expect(output).toContain('sandbox-run:')
  })
})

describeWin('tools-shell 与 sandbox 集成（P6-0a 回归）', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(TEST_TMP, 'heluo-shell-sandbox-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('restricted-write 下 run_command 正常执行（UTF-8 中文）', async () => {
    const ctx = makeCtx()
    toolsShellPlugin(ctx)
    const tool = ctx.root.tools!.get!('run_command')
    const r = await tool!.execute(
      { command: '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output "你好 heluo"' },
      { cwd, signal: new AbortController().signal, session: { append() {} }, callId: 'c1' } as unknown as ToolContext,
    )
    expect(r.ok).toBe(true)
    expect((r.ok ? r.outputForModel : r.errorForModel) ?? '').toContain('你好 heluo')
  })

  it('run_command 超时：沙箱进程树被终止且不挂起', async () => {
    const ctx = makeCtx()
    toolsShellPlugin(ctx)
    const tool = ctx.root.tools!.get!('run_command')
    const started = Date.now()
    const r = await tool!.execute(
      { command: 'Start-Sleep 10', timeout_ms: 800 },
      { cwd, signal: new AbortController().signal, session: { append() {} }, callId: 'c1' } as unknown as ToolContext,
    )
    expect(r.ok).toBe(false)
    expect(Date.now() - started).toBeLessThan(8000)
    expect((r.ok ? r.outputForModel : r.errorForModel) ?? '').toContain('超时')
  })
})