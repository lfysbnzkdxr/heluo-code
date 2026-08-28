import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boot } from '../index'
import { registerMockStepScript } from '../plugins/llm-mock'
import type { SessionEvent } from '../shared/events'

describe('P2 验收场景', () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'heluo-p2-'))
  })
  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('G1 闭环：新建脚本→运行报错→读文件→修复→再运行通过', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'heluo-loop-'))
    const app = await boot(
      { cwd },
      {
        model: 'mock/loop',
        providers: { mock: { type: 'mock' } },
        permission: { mode: 'quest', questRunCommand: 'allow' },
      },
    )
    const ctx = app.ctx
    registerMockStepScript('loop', [
      [
        { type: 'text-delta', delta: '先写一个脚本' },
        {
          type: 'tool-call',
          call: { id: 's1', name: 'write_file', argsJson: JSON.stringify({ path: 'script.js', content: 'console.log(undefinedVar)' }) },
        },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', delta: '运行看看' },
        { type: 'tool-call', call: { id: 's2', name: 'run_command', argsJson: JSON.stringify({ command: 'node script.js' }) } },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', delta: '读一下脚本定位错误' },
        { type: 'tool-call', call: { id: 's3', name: 'read_file', argsJson: JSON.stringify({ path: 'script.js' }) } },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', delta: '修复脚本' },
        {
          type: 'tool-call',
          call: {
            id: 's4',
            name: 'edit_file',
            argsJson: JSON.stringify({
              path: 'script.js',
              old_string: 'console.log(undefinedVar)',
              new_string: 'const undefinedVar = 42\nconsole.log(undefinedVar)',
            }),
          },
        },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', delta: '再运行确认' },
        { type: 'tool-call', call: { id: 's5', name: 'run_command', argsJson: JSON.stringify({ command: 'node script.js' }) } },
        { type: 'done' },
      ],
      [{ type: 'text-delta', delta: '修复完成，脚本输出 42' }, { type: 'done' }],
    ])

    const session = ctx.agentLoop!.createSession(cwd)
    const events: SessionEvent[] = []
    session.subscribe((e) => events.push(e))

    const result = await ctx.agentLoop!.openTurn({ session, text: '写一个脚本并跑通' })
    await app.shutdown()

    expect(result.stopReason).toBe('completed')
    expect(events[0]!.type).toBe('turn/start')
    expect(events[events.length - 1]!.type).toBe('turn/end')

    const calls = events.filter((e) => e.type === 'tool/call').map((e) => (e.properties as { name: string }).name)
    expect(calls).toEqual(['write_file', 'run_command', 'read_file', 'edit_file', 'run_command'])

    const results = events.filter((e) => e.type === 'tool/result')
    const runResults = results.filter(
      (e) => (e.properties as { callId: string }).callId === 's2' || (e.properties as { callId: string }).callId === 's5',
    )
    const firstRun = runResults[0]!.properties as { isError: boolean; output: string }
    expect(firstRun.isError).toBe(true)
    expect(firstRun.output).toContain('ReferenceError')
    const secondRun = runResults[1]!.properties as { isError: boolean; output: string }
    expect(secondRun.isError).toBe(false)
    expect(secondRun.output).toContain('42')

    const streams = events.filter((e) => e.type === 'tool/stream')
    expect(streams.length).toBeGreaterThan(0)

    expect(readFileSync(join(cwd, 'script.js'), 'utf8')).toBe('const undefinedVar = 42\nconsole.log(undefinedVar)')
  })

  it('G2 权限记忆跨步：always 后不再弹确认；allow 不记忆；deny 生效', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'heluo-perm-'))
    const app = await boot(
      { cwd },
      {
        model: 'mock/perm',
        providers: { mock: { type: 'mock' } },
        permission: { mode: 'agent' },
      },
    )
    const ctx = app.ctx
    registerMockStepScript('perm', [
      [
        { type: 'text-delta', delta: '写第一个文件' },
        { type: 'tool-call', call: { id: 'p1', name: 'write_file', argsJson: JSON.stringify({ path: 'a.txt', content: 'one' }) } },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', delta: '写第二个文件' },
        { type: 'tool-call', call: { id: 'p2', name: 'write_file', argsJson: JSON.stringify({ path: 'b.txt', content: 'two' }) } },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', delta: '运行命令（allow 不记忆）' },
        { type: 'tool-call', call: { id: 'p3', name: 'run_command', argsJson: JSON.stringify({ command: 'Write-Output ok' }) } },
        { type: 'done' },
      ],
      [
        { type: 'text-delta', delta: '再次运行同前缀命令（仍应询问，因为上次是 allow 非 always）' },
        { type: 'tool-call', call: { id: 'p4', name: 'run_command', argsJson: JSON.stringify({ command: 'Write-Output nope' }) } },
        { type: 'done' },
      ],
      [{ type: 'text-delta', delta: '结束' }, { type: 'done' }],
    ])

    const session = ctx.agentLoop!.createSession(cwd)
    const requests: Array<{ id: string; tool: string }> = []
    ctx.permissions!.onRequest((req) => requests.push({ id: req.id, tool: req.tool }))
    const events: SessionEvent[] = []
    session.subscribe((e) => events.push(e))

    const p = ctx.agentLoop!.openTurn({ session, text: '写两个文件并跑命令' })
    // 权限自动应答：write_file → always；run_command 首次 → allow（不记忆）、第二次 → deny
    const responded = new Set<string>()
    let respondedRuns = 0
    const responder = setInterval(() => {
      for (const req of requests) {
        if (responded.has(req.id)) continue
        responded.add(req.id)
        if (req.tool === 'write_file') {
          ctx.permissions!.respond(req.id, 'always')
        } else {
          respondedRuns++
          ctx.permissions!.respond(req.id, respondedRuns === 1 ? 'allow' : 'deny')
        }
      }
    }, 10)

    const result = await Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('HANG')), 10000)),
    ])
    clearInterval(responder)
    await app.shutdown()

    expect(result.stopReason).toBe('completed')
    // 权限询问序列：write_file ×1（always 后同工具不再问）、run_command ×2（allow 不记忆）
    const writeRequests = requests.filter((r) => r.tool === 'write_file')
    const runRequests = requests.filter((r) => r.tool === 'run_command')
    expect(writeRequests.length).toBe(1)
    expect(runRequests.length).toBe(2)
    // 决策闭环：always → allow → deny
    const decisions = events
      .filter((e) => e.type === 'permission/response')
      .map((e) => (e.properties as { decision: string }).decision)
    expect(decisions).toEqual(['always', 'allow', 'deny'])

    // 两个文件均写入成功；被 deny 的 run_command 不产生成功结果
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('one')
    expect(readFileSync(join(cwd, 'b.txt'), 'utf8')).toBe('two')
    const runResults = events
      .filter((e) => e.type === 'tool/result')
      .filter((e) => {
        const id = (e.properties as { callId: string }).callId
        return id === 'p3' || id === 'p4'
      })
    expect((runResults[0]!.properties as { isError: boolean }).isError).toBe(false) // allow 放行
    expect((runResults[1]!.properties as { isError: boolean }).isError).toBe(true) // deny 拒绝
  })
})
