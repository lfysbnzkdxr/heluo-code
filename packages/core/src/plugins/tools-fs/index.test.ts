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
      session: { id: 's', cwd, inject() {}, takeInject: () => [], append() { return {} as never } },
      callId: 'c1',
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

  it('edit_file 替换唯一匹配（先 read 后 edit）', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(cwd, 'e.txt'), 'foo bar foo')
    const read = ctx.tools!.get('read_file')!
    await read.execute({ path: 'e.txt' }, tctx())
    const edit = ctx.tools!.get('edit_file')!
    const out = (await edit.execute({ path: 'e.txt', old_string: 'bar', new_string: 'BAZ' }, tctx())) as ToolOutcome
    expect(out.ok).toBe(true)
    expect(readFileSync(join(cwd, 'e.txt'), 'utf8')).toBe('foo BAZ foo')
  })

  it('edit_file 未先 read 被软约束拒绝', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(cwd, 'f.txt'), 'content')
    const edit = ctx.tools!.get('edit_file')!
    const out = (await edit.execute({ path: 'f.txt', old_string: 'content', new_string: 'x' }, tctx())) as ToolOutcome
    expect(out.ok).toBe(false)
    expect((out as { errorForModel: string }).errorForModel).toContain('read')
  })

  it('edit_file 匹配不唯一时报错并列数量', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(cwd, 'g.txt'), 'abc abc abc')
    const read = ctx.tools!.get('read_file')!
    await read.execute({ path: 'g.txt' }, tctx())
    const edit = ctx.tools!.get('edit_file')!
    const out = (await edit.execute({ path: 'g.txt', old_string: 'abc', new_string: 'x' }, tctx())) as ToolOutcome
    expect(out.ok).toBe(false)
    expect((out as { errorForModel: string }).errorForModel).toContain('3 处')
  })

  it('edit_file 匹配 0 处时报错', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(cwd, 'h.txt'), 'hello')
    const read = ctx.tools!.get('read_file')!
    await read.execute({ path: 'h.txt' }, tctx())
    const edit = ctx.tools!.get('edit_file')!
    const out = (await edit.execute({ path: 'h.txt', old_string: 'nope', new_string: 'x' }, tctx())) as ToolOutcome
    expect(out.ok).toBe(false)
    expect((out as { errorForModel: string }).errorForModel).toContain('0 处')
  })

  it('edit_file replace_all 替换全部', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(cwd, 'i.txt'), 'abc abc')
    const read = ctx.tools!.get('read_file')!
    await read.execute({ path: 'i.txt' }, tctx())
    const edit = ctx.tools!.get('edit_file')!
    const out = (await edit.execute({ path: 'i.txt', old_string: 'abc', new_string: 'x', replace_all: true }, tctx())) as ToolOutcome
    expect(out.ok).toBe(true)
    expect(readFileSync(join(cwd, 'i.txt'), 'utf8')).toBe('x x')
  })

  it('edit_file 拒绝 cwd 之外路径', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const edit = ctx.tools!.get('edit_file')!
    const out = (await edit.execute({ path: '/etc/hostname', old_string: 'x', new_string: 'y' }, tctx())) as ToolOutcome
    expect(out.ok).toBe(false)
  })

  it('list_dir 列出目录与文件并忽略排除项', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(cwd, 'src'))
    mkdirSync(join(cwd, 'node_modules'))
    writeFileSync(join(cwd, 'src', 'a.ts'), 'x')
    writeFileSync(join(cwd, 'README.md'), 'y')
    const tool = ctx.tools!.get('list_dir')!
    const out = (await tool.execute({}, tctx())) as ToolOutcome
    const text = (out as { outputForModel: string }).outputForModel
    expect(out.ok).toBe(true)
    expect(text).toContain('src/ (dir)')
    expect(text).toContain('README.md (1 bytes)')
    expect(text).not.toContain('node_modules')
  })

  it('list_dir depth 控制递归层数', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(cwd, 'a', 'b'), { recursive: true })
    writeFileSync(join(cwd, 'a', 'b', 'deep.txt'), 'x')
    const tool = ctx.tools!.get('list_dir')!
    const shallow = (await tool.execute({ path: '.', depth: 1 }, tctx())) as ToolOutcome
    expect((shallow as { outputForModel: string }).outputForModel).not.toContain('deep.txt')
    const deep = (await tool.execute({ path: '.', depth: 3 }, tctx())) as ToolOutcome
    expect((deep as { outputForModel: string }).outputForModel).toContain('a/b/deep.txt')
  })

  it('list_dir 拒绝 cwd 之外路径', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const tool = ctx.tools!.get('list_dir')!
    const out = (await tool.execute({ path: '/etc' }, tctx())) as ToolOutcome
    expect(out.ok).toBe(false)
  })

  it('grep_search 输出 path:line: text', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'a.ts'), 'const x = 1\nconst y = 2')
    const tool = ctx.tools!.get('grep_search')!
    const out = (await tool.execute({ pattern: 'const y' }, tctx())) as ToolOutcome
    expect(out.ok).toBe(true)
    expect((out as { outputForModel: string }).outputForModel).toContain('src/a.ts:2: const y = 2')
  })

  it('grep_search include glob 过滤文件', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(cwd, 'hit.ts'), 'needle')
    writeFileSync(join(cwd, 'miss.js'), 'needle')
    const tool = ctx.tools!.get('grep_search')!
    const out = (await tool.execute({ pattern: 'needle', include: '*.ts' }, tctx())) as ToolOutcome
    expect((out as { outputForModel: string }).outputForModel).toContain('hit.ts:1')
    expect((out as { outputForModel: string }).outputForModel).not.toContain('miss.js')
  })

  it('grep_search 超 max_results 截断并标注', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const { writeFileSync } = await import('node:fs')
    const lines = Array.from({ length: 5 }, (_, i) => `match line ${i}`).join('\n')
    writeFileSync(join(cwd, 'many.txt'), lines)
    const tool = ctx.tools!.get('grep_search')!
    const out = (await tool.execute({ pattern: 'match', max_results: 3 }, tctx())) as ToolOutcome
    const text = (out as { outputForModel: string }).outputForModel
    expect(text).toContain('达到上限 3')
  })

  it('grep_search 忽略 node_modules 且拒绝 cwd 之外路径', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(cwd, 'node_modules'))
    writeFileSync(join(cwd, 'node_modules', 'dep.js'), 'needle')
    const tool = ctx.tools!.get('grep_search')!
    const ok = (await tool.execute({ pattern: 'needle' }, tctx())) as ToolOutcome
    expect((ok as { outputForModel: string }).outputForModel).not.toContain('dep.js')
    const bad = (await tool.execute({ pattern: 'x', path: '/etc' }, tctx())) as ToolOutcome
    expect(bad.ok).toBe(false)
  })

  it('grep_search gitignore 按目录层级生效：子目录规则不波及兄弟目录', async () => {
    const ctx = makeCtx()
    toolsFsPlugin(ctx)
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    mkdirSync(join(cwd, 'test'), { recursive: true })
    writeFileSync(join(cwd, '.gitignore'), '*.root-only\n')
    writeFileSync(join(cwd, 'src', '.gitignore'), '*.gen.ts\n')
    writeFileSync(join(cwd, 'a.gen.ts'), 'marker')
    writeFileSync(join(cwd, 'src', 'b.gen.ts'), 'marker')
    writeFileSync(join(cwd, 'src', 'd.root-only'), 'marker')
    writeFileSync(join(cwd, 'test', 'c.gen.ts'), 'marker')
    const tool = ctx.tools!.get('grep_search')!
    const out = (await tool.execute({ pattern: 'marker' }, tctx())) as ToolOutcome
    const text = (out as { outputForModel: string }).outputForModel
    // 根目录文件不受 src/.gitignore 影响
    expect(text).toContain('a.gen.ts')
    // src/.gitignore 忽略本目录内 *.gen.ts
    expect(text).not.toContain('b.gen.ts')
    // 兄弟目录 test 不受 src/.gitignore 波及
    expect(text).toContain('test/c.gen.ts')
    // 父级 .gitignore 规则仍对子级生效
    expect(text).not.toContain('d.root-only')
  })
})
