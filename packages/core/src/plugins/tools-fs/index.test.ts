import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContext } from '../../context'
import type { ToolContext, ToolOutcome } from '../../services/tools/types'
import { toolsPlugin } from '../../services/tools'
import { toolsFsPlugin } from './index'

function makeCtx() {
  const ctx = createContext()
  ctx.provide('config', {
    get: () => ({
      model: '',
      providers: {},
      plugins: [],
      permission: { mode: 'agent' as const },
      loop: { maxStepsPerTurn: 40 },
      rules: [],
      tools: { exclude: [], grepMaxResults: 100, outputTruncateHead: 500, outputTruncateTail: 500 },
    }),
  })
  toolsPlugin(ctx)
  return ctx
}

describe('tools-fs', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'heluo-fs-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  function tctx(): ToolContext {
    return {
      cwd,
      signal: new AbortController().signal,
      session: {} as unknown as ToolContext['session'],
      inject() {},
    } as ToolContext
  }

  it('read_file outputs line numbers', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const file = join(cwd, 'a.txt')
    const content = 'line1\nline2\nline3'
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, content)
    const tool = ctx.tools!.get('read_file')!
    const out = (await tool.execute({ path: 'a.txt' }, tctx())) as ToolOutcome
    expect(out.ok).toBe(true)
    expect((out as { outputForModel: string }).outputForModel).toContain('1\tline1')
    expect((out as { outputForModel: string }).outputForModel).toContain('3\tline3')
  })

  it('read_file detects binary files', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(cwd, 'b.bin'), Buffer.from([0, 1, 2]))
    const tool = ctx.tools!.get('read_file')!
    const out = (await tool.execute({ path: 'b.bin' }, tctx())) as ToolOutcome
    expect(out.ok).toBe(false)
  })

  it('write_file creates parent dirs and returns byte count', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const tool = ctx.tools!.get('write_file')!
    const out = (await tool.execute({ path: 'sub/c.txt', content: 'hello' }, tctx())) as ToolOutcome
    expect(out.ok).toBe(true)
    expect(readFileSync(join(cwd, 'sub/c.txt'), 'utf8')).toBe('hello')
  })

  it('read_file 拒绝读取 cwd 之外绝对路径', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const tool = ctx.tools!.get('read_file')!
    const out = (await tool.execute({ path: '/etc/hostname' }, tctx())) as ToolOutcome
    expect(out.ok).toBe(false)
  })

  it('write_file 拒绝写入 cwd 之外绝对路径', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const tool = ctx.tools!.get('write_file')!
    const out = (await tool.execute({ path: '/tmp/evil.txt', content: 'x' }, tctx())) as ToolOutcome
    expect(out.ok).toBe(false)
  })

  it('signal 已 abort 时 read_file 不触碰磁盘', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const file = join(cwd, 'c.txt')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, 'data')
    const ac = new AbortController()
    ac.abort()
    const tool = ctx.tools!.get('read_file')!
    const out = (await tool.execute({ path: 'c.txt' }, { ...tctx(), signal: ac.signal })) as ToolOutcome
    expect(out.ok).toBe(false)
  })

  it('signal 已 abort 时 write_file 不产生文件', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const ac = new AbortController()
    ac.abort()
    const tool = ctx.tools!.get('write_file')!
    const out = (await tool.execute({ path: 'sub/d.txt', content: 'x' }, { ...tctx(), signal: ac.signal })) as ToolOutcome
    expect(out.ok).toBe(false)
    expect(() => readFileSync(join(cwd, 'sub/d.txt'), 'utf8')).toThrow()
  })

  it('read_file offset 越界返回提示而非空串', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(cwd, 'big.txt'), Array.from({ length: 2500 }, (_, i) => `line${i}`).join('\n'))
    const tool = ctx.tools!.get('read_file')!
    const out = (await tool.execute({ path: 'big.txt', offset: 2500 }, tctx())) as ToolOutcome
    expect(out.ok).toBe(true)
    expect((out as { outputForModel: string }).outputForModel).toContain('超出文件总行数')
  })

  it('cwd 内以 .. 前缀命名的目录（..foo）不被误拒', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(cwd, '..foo'))
    writeFileSync(join(cwd, '..foo', 'x.txt'), 'data')
    const tool = ctx.tools!.get('read_file')!
    const out = (await tool.execute({ path: '..foo/x.txt' }, tctx())) as ToolOutcome
    expect(out.ok).toBe(true)
    expect((out as { outputForModel: string }).outputForModel).toContain('data')
  })
})
