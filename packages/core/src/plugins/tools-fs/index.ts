import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@cordisjs/core'
import type { Config } from '../../plugins/config/schema'
import type { ToolContext, ToolDefinition, ToolOutcome } from '../../services/tools/types'

const MAX_READ_LINES = 2000

function withinCwd(cwd: string, abs: string): boolean {
  const rel = relative(cwd, abs)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

function getConfig(ctx: Context): Config {
  return ctx.config?.get() as Config
}

function readFileTool(ctx: Context): ToolDefinition {
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
      const cfg = getConfig(ctx)
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

      const head = cfg.tools.outputTruncateHead
      const tail = cfg.tools.outputTruncateTail
      let body: string[]
      if (windowLines.length > head + tail && head + tail > 0) {
        const keptHead = windowLines.slice(0, head)
        const keptTail = windowLines.slice(windowLines.length - tail)
        const truncated = windowLines.length - head - tail
        body = [
          ...keptHead.map((l, i) => `${start + 1 + i}\t${l}`),
          `...[truncated ${truncated} lines]...`,
          ...keptTail.map((l, i) => `${start + 1 + head + i}\t${l}`),
        ]
      } else {
        body = windowLines.map((l, i) => `${start + 1 + i}\t${l}`)
      }

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

export function toolsFsPlugin(ctx: Context): void {
  ctx.root.tools!.register(readFileTool(ctx))
  ctx.root.tools!.register(writeFileTool())
}

void Object.assign(toolsFsPlugin, { inject: ['tools'] })
