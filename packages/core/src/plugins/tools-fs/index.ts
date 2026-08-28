import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@cordisjs/core'
import { withinCwd } from '../../shared/path'
import { truncateLines } from '../../shared/output'
import type { Config } from '../../plugins/config/schema'
import type { ToolContext, ToolDefinition, ToolOutcome } from '../../services/tools/types'

const MAX_READ_LINES = 2000
const DEFAULT_EXCLUDES = ['.git', 'node_modules', 'dist']

function getConfig(ctx: Context): Config {
  return ctx.config?.get() as Config
}

// —— gitignore 尽力而为匹配（v1 简化：* → .*、? → .，其余字面转义；忽略 ! 反转语义）——
function gitignorePatterns(text: string): RegExp[] {
  const patterns: RegExp[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^!\s*/, '')
    if (!trimmed || trimmed.startsWith('#')) continue
    const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
    patterns.push(new RegExp('^' + escaped + '$'))
  }
  return patterns
}

function matchesAny(patterns: RegExp[], name: string, relPath: string): boolean {
  return patterns.some((p) => p.test(name) || p.test(relPath))
}

function readFileTool(ctx: Context, readMemory: Map<string, Set<string>>): ToolDefinition {
  return {
    name: 'read_file',
    description: '读取文件内容，带行号输出；支持 offset/limit 分页。遇二进制文件报错。',
    permission: 'allow',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对 cwd 或绝对路径' },
        offset: { type: 'number', description: '起始行（1-based）' },
        limit: { type: 'number', description: '读取行数' },
      },
      required: ['path'],
    },
    async execute(args: unknown, tctx: ToolContext): Promise<ToolOutcome> {
      const { path, offset, limit } = (args ?? {}) as { path?: unknown; offset?: unknown; limit?: unknown }
      if (typeof path !== 'string' || path.length === 0) {
        return { ok: false, errorForModel: 'read_file: 缺少 path 参数' }
      }
      if (tctx.signal.aborted) return { ok: false, errorForModel: 'read_file: 操作已取消' }
      const abs = isAbsolute(path) ? path : resolve(tctx.cwd, path)
      if (!withinCwd(tctx.cwd, abs)) {
        return { ok: false, errorForModel: `read_file: 拒绝读取 cwd 之外路径：${path}` }
      }
      let raw: Buffer
      try {
        raw = readFileSync(abs)
      } catch {
        return { ok: false, errorForModel: `read_file: 无法读取文件 ${path}` }
      }
      if (raw.includes(0)) {
        return { ok: false, errorForModel: `read_file: ${path} 疑似二进制文件，请使用 run_command 或其它方式处理` }
      }
      let lines = raw.toString('utf8').split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

      if (lines.length > MAX_READ_LINES) {
        lines = lines.slice(0, MAX_READ_LINES)
        lines.push(`[read_file] 文件过长，仅显示前 ${MAX_READ_LINES} 行，请用 offset/limit 分页`)
      }

      const start = typeof offset === 'number' && offset > 0 ? offset - 1 : 0
      const end = typeof limit === 'number' && limit > 0 ? Math.min(start + limit, lines.length) : lines.length
      if (typeof offset === 'number' && offset > 0 && start >= lines.length) {
        return {
          ok: true,
          outputForModel: `[read_file] offset ${offset} 超出文件总行数 ${lines.length}，请缩小 offset`,
        }
      }
      const windowLines = lines.slice(start, end)

      const numbered = windowLines.map((l, i) => `${start + 1 + i}\t${l}`)
      const body = truncateLines(numbered, getConfig(ctx).tools.outputTruncateHead, getConfig(ctx).tools.outputTruncateTail)

      const set = readMemory.get(tctx.session.id) ?? new Set<string>()
      set.add(abs)
      readMemory.set(tctx.session.id, set)

      return { ok: true, outputForModel: body.join('\n') }
    },
  }
}

function writeFileTool(): ToolDefinition {
  return {
    name: 'write_file',
    description: '以 UTF-8 整文件覆写目标文件；父目录不存在自动创建；返回写入字节数。',
    permission: 'ask',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件' },
        content: { type: 'string', description: '完整内容' },
      },
      required: ['path', 'content'],
    },
    async execute(args: unknown, tctx: ToolContext): Promise<ToolOutcome> {
      const { path, content } = (args ?? {}) as { path?: unknown; content?: unknown }
      if (typeof path !== 'string' || path.length === 0) {
        return { ok: false, errorForModel: 'write_file: 缺少 path 参数' }
      }
      if (typeof content !== 'string') {
        return { ok: false, errorForModel: 'write_file: 缺少 content 参数' }
      }
      if (tctx.signal.aborted) return { ok: false, errorForModel: 'write_file: 操作已取消' }
      const abs = isAbsolute(path) ? path : resolve(tctx.cwd, path)
      if (!withinCwd(tctx.cwd, abs)) {
        return { ok: false, errorForModel: `write_file: 拒绝写入 cwd 之外路径：${path}` }
      }
      try {
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content, 'utf8')
        const rel = relative(tctx.cwd, abs)
        return { ok: true, outputForModel: `已写入 ${Buffer.byteLength(content, 'utf8')} 字节至 ${rel || abs}（UTF-8）` }
      } catch (error) {
        return { ok: false, errorForModel: `write_file: 写入失败 ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}

function editFileTool(ctx: Context, readMemory: Map<string, Set<string>>): ToolDefinition {
  return {
    name: 'edit_file',
    description: '在文件中精确替换文本。old_string 必须唯一匹配（或开 replace_all）；要求同会话先 read 过该文件。',
    permission: 'ask',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件' },
        old_string: { type: 'string', description: '必须精确匹配且唯一的原文' },
        new_string: { type: 'string', description: '替换文本' },
        replace_all: { type: 'boolean', description: '替换全部匹配处，默认 false' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async execute(args: unknown, tctx: ToolContext): Promise<ToolOutcome> {
      const { path, old_string, new_string, replace_all } = (args ?? {}) as {
        path?: unknown
        old_string?: unknown
        new_string?: unknown
        replace_all?: unknown
      }
      if (typeof path !== 'string' || path.length === 0) {
        return { ok: false, errorForModel: 'edit_file: 缺少 path 参数' }
      }
      if (typeof old_string !== 'string' || old_string.length === 0) {
        return { ok: false, errorForModel: 'edit_file: 缺少 old_string 参数' }
      }
      if (typeof new_string !== 'string') {
        return { ok: false, errorForModel: 'edit_file: 缺少 new_string 参数' }
      }
      if (tctx.signal.aborted) return { ok: false, errorForModel: 'edit_file: 操作已取消' }
      const abs = isAbsolute(path) ? path : resolve(tctx.cwd, path)
      if (!withinCwd(tctx.cwd, abs)) {
        return { ok: false, errorForModel: `edit_file: 拒绝修改 cwd 之外路径：${path}` }
      }
      if (getConfig(ctx).tools.editRequiresRead) {
        if (!readMemory.get(tctx.session.id)?.has(abs)) {
          return {
            ok: false,
            errorForModel: `edit_file: 同会话尚未 read 过该文件（${path}）。请先调用 read_file 读取后再编辑（可用配置 tools.editRequiresRead 关闭此检查）`,
          }
        }
      }
      let raw: string
      try {
        raw = readFileSync(abs, 'utf8')
      } catch {
        return { ok: false, errorForModel: `edit_file: 无法读取文件 ${path}` }
      }
      const count = raw.split(old_string).length - 1
      if (count === 0) {
        return { ok: false, errorForModel: `edit_file: old_string 匹配 0 处，请加长上下文锚定后重试` }
      }
      if (count > 1 && !replace_all) {
        return { ok: false, errorForModel: `edit_file: old_string 匹配 ${count} 处，不唯一。请加长上下文锚定，或开启 replace_all 替换全部` }
      }
      const updated = replace_all ? raw.split(old_string).join(new_string) : raw.replace(old_string, new_string)
      try {
        writeFileSync(abs, updated, 'utf8')
        const rel = relative(tctx.cwd, abs)
        return { ok: true, outputForModel: `已替换 ${count} 处至 ${rel || abs}` }
      } catch (error) {
        return { ok: false, errorForModel: `edit_file: 写入失败 ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}

function listDirTool(ctx: Context): ToolDefinition {
  return {
    name: 'list_dir',
    description: '列出目录内容（递归深度可配），标注目录/文件与大小；忽略 .git/node_modules/dist 等排除项。',
    permission: 'allow',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对 cwd 或绝对路径，默认 "."' },
        depth: { type: 'number', description: '递归深度，默认 1' },
      },
    },
    async execute(args: unknown, tctx: ToolContext): Promise<ToolOutcome> {
      const { path, depth } = (args ?? {}) as { path?: unknown; depth?: unknown }
      const dirArg = typeof path === 'string' && path.length > 0 ? path : '.'
      if (tctx.signal.aborted) return { ok: false, errorForModel: 'list_dir: 操作已取消' }
      const abs = isAbsolute(dirArg) ? dirArg : resolve(tctx.cwd, dirArg)
      if (!withinCwd(tctx.cwd, abs)) {
        return { ok: false, errorForModel: `list_dir: 拒绝列出 cwd 之外路径：${path}` }
      }
      const maxDepth = typeof depth === 'number' && depth > 0 ? depth : 1
      const excludes = [...DEFAULT_EXCLUDES, ...getConfig(ctx).tools.exclude]
      const lines: string[] = []
      const walk = (dirAbs: string, relPrefix: string, level: number): void => {
        if (tctx.signal.aborted) return
        let entries
        try {
          entries = readdirSync(dirAbs, { withFileTypes: true })
        } catch {
          lines.push(`${relPrefix || '.'} (无法读取)`)
          return
        }
        const dirs = entries
          .filter((e) => e.isDirectory() && !excludes.includes(e.name))
          .map((e) => e.name)
          .sort()
        const files = entries
          .filter((e) => e.isFile())
          .map((e) => e.name)
          .sort()
        for (const name of dirs) {
          const relPath = relPrefix ? `${relPrefix}/${name}` : name
          lines.push(`${relPath}/ (dir)`)
          if (level < maxDepth) walk(join(dirAbs, name), relPath, level + 1)
        }
        for (const name of files) {
          const relPath = relPrefix ? `${relPrefix}/${name}` : name
          let size = 0
          try {
            size = statSync(join(dirAbs, name)).size
          } catch {
            /* ignore */
          }
          lines.push(`${relPath} (${size} bytes)`)
        }
      }
      walk(abs, '', 1)
      const body = truncateLines(lines, getConfig(ctx).tools.outputTruncateHead, getConfig(ctx).tools.outputTruncateTail)
      return { ok: true, outputForModel: body.join('\n') }
    },
  }
}

function grepSearchTool(ctx: Context): ToolDefinition {
  return {
    name: 'grep_search',
    description: '按 JS 正则搜索文件内容，输出 path:line: text；支持 include glob 与 max_results 上限。',
    permission: 'allow',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JS 正则（不含 / 定界符）' },
        path: { type: 'string', description: '搜索根，默认 "."' },
        include: { type: 'string', description: '文件 glob，如 "*.ts"' },
        max_results: { type: 'number', description: '结果上限' },
      },
      required: ['pattern'],
    },
    async execute(args: unknown, tctx: ToolContext): Promise<ToolOutcome> {
      const { pattern, path, include, max_results } = (args ?? {}) as {
        pattern?: unknown
        path?: unknown
        include?: unknown
        max_results?: unknown
      }
      if (typeof pattern !== 'string' || pattern.length === 0) {
        return { ok: false, errorForModel: 'grep_search: 缺少 pattern 参数' }
      }
      if (tctx.signal.aborted) return { ok: false, errorForModel: 'grep_search: 操作已取消' }
      let regex: RegExp
      try {
        regex = new RegExp(pattern)
      } catch (error) {
        return { ok: false, errorForModel: `grep_search: 非法正则：${error instanceof Error ? error.message : String(error)}` }
      }
      const rootArg = typeof path === 'string' && path.length > 0 ? path : '.'
      const abs = isAbsolute(rootArg) ? rootArg : resolve(tctx.cwd, rootArg)
      if (!withinCwd(tctx.cwd, abs)) {
        return { ok: false, errorForModel: `grep_search: 拒绝搜索 cwd 之外路径：${path}` }
      }
      const cfg = getConfig(ctx)
      const limit = typeof max_results === 'number' && max_results > 0 ? max_results : cfg.tools.grepMaxResults
      const excludes = [...DEFAULT_EXCLUDES, ...cfg.tools.exclude]
      const includeRe = typeof include === 'string' && include.length > 0
        ? new RegExp('^' + include.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
        : null
      const out: string[] = []
      const ignorePatterns: RegExp[] = []

      const walk = (dirAbs: string, relPrefix: string): void => {
        // gitignore 语义：父级模式对子级生效、兄弟目录互不影响。
        // 进入目录压入本级模式，退出（含所有提前返回路径）恢复父级栈。
        const baseLen = ignorePatterns.length
        try {
          if (tctx.signal.aborted || out.length >= limit) return
          let entries
          try {
            entries = readdirSync(dirAbs, { withFileTypes: true })
          } catch {
            return
          }
          let ignores: RegExp[] = []
          try {
            ignores = gitignorePatterns(readFileSync(join(dirAbs, '.gitignore'), 'utf8'))
          } catch {
            /* no .gitignore */
          }
          ignorePatterns.push(...ignores)
          for (const entry of entries) {
            if (tctx.signal.aborted || out.length >= limit) return
            const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
            if (matchesAny(ignorePatterns, entry.name, relPath)) continue
            if (entry.isDirectory()) {
              if (excludes.includes(entry.name)) continue
              walk(join(dirAbs, entry.name), relPath)
            } else if (entry.isFile()) {
              if (includeRe && !includeRe.test(entry.name) && !includeRe.test(relPath)) continue
              if (relPath.startsWith('.git/')) continue
              let raw: Buffer
              try {
                raw = readFileSync(join(dirAbs, entry.name))
              } catch {
                continue
              }
              if (raw.includes(0)) continue
              const lines = raw.toString('utf8').split('\n')
              for (let i = 0; i < lines.length && out.length < limit; i++) {
                if (regex.test(lines[i]!)) {
                  out.push(`${relPath}:${i + 1}: ${lines[i]}`)
                }
              }
            }
          }
        } finally {
          ignorePatterns.length = baseLen
        }
      }
      walk(abs, '')
      if (out.length >= limit) {
        out.push(`[grep_search] 结果达到上限 ${limit}，已截断；可缩小 pattern 或调大 max_results`)
      }
      const body = truncateLines(out, cfg.tools.outputTruncateHead, cfg.tools.outputTruncateTail)
      return { ok: true, outputForModel: body.join('\n') }
    },
  }
}

export function toolsFsPlugin(ctx: Context): void {
  const readMemory = new Map<string, Set<string>>() // sessionId -> 已 read 的绝对路径集合
  ctx.root.tools!.register(readFileTool(ctx, readMemory))
  ctx.root.tools!.register(writeFileTool())
  ctx.root.tools!.register(editFileTool(ctx, readMemory))
  ctx.root.tools!.register(listDirTool(ctx))
  ctx.root.tools!.register(grepSearchTool(ctx))
}

void Object.assign(toolsFsPlugin, { inject: ['tools'] })
