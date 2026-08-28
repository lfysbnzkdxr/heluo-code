import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@cordisjs/core'
import type { Config } from '../../plugins/config/schema'
import { logger } from '../../shared/logger'

export interface PromptSegment {
  name: string
  get(): string
}

export interface SystemPromptService {
  register(segment: PromptSegment): () => void
  getSystemPrompt(cwd?: string): string
}

const AGENTS_MD_LIMIT = 32 * 1024

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function discoverAgentsMd(cwd: string | undefined): string {
  const parts: string[] = []
  const globalPath = join(process.env.HELUO_CODE_HOME ?? join(homedir(), '.heluo-code'), 'AGENTS.md')
  const globalMd = readIfExists(globalPath)
  if (globalMd) parts.push(`# 全局指令 (~/.heluo-code/AGENTS.md)\n\n${globalMd}`)
  if (cwd) {
    const projectMd = readIfExists(join(cwd, 'AGENTS.md'))
    if (projectMd) parts.push(`# 项目指令 (${cwd}/AGENTS.md)\n\n${projectMd}`)
  }
  if (parts.length === 0) return ''
  const joined = parts.join('\n\n')
  if (joined.length > AGENTS_MD_LIMIT) {
    logger.warn('AGENTS.md 超出 32KiB，已截断')
    return joined.slice(0, AGENTS_MD_LIMIT)
  }
  return joined
}

export function systemPromptPlugin(ctx: Context): void {
  const segments: PromptSegment[] = []
  const config = ctx.root.config?.get() as Config | undefined

  segments.push({
    name: 'identity',
    get: () =>
      [
        '你是 heluo-code，一个运行在用户本地机器上的 AI 编程助手。',
        '你通过工具读写文件、执行命令来完成真实编码任务。',
        '只做被明确要求的事；不编造文件内容；不确定时先读取再修改。',
      ].join('\n'),
  })

  segments.push({
    name: 'tool-usage',
    get: () =>
      [
        '## 工具使用约定',
        '- 需要读取文件时使用 read_file；需要写入文件时使用 write_file。',
        '- 调用工具前先用自然语言说明意图；工具返回结果会作为后续上下文。',
        '- 不要臆测文件内容，先 read_file 再 edit/write。',
      ].join('\n'),
  })

  if (config?.rules && config.rules.length > 0) {
    segments.push({
      name: 'rules',
      get: () => `## 附加规则\n\n${config.rules.map((r) => `- ${r}`).join('\n')}`,
    })
  }

  const service: SystemPromptService = {
    register(segment) {
      segments.push(segment)
      return () => {
        const idx = segments.indexOf(segment)
        if (idx >= 0) segments.splice(idx, 1)
      }
    },
    getSystemPrompt(cwd?: string) {
      const out: string[] = []
      for (const seg of segments) {
        try {
          const text = seg.get()
          if (text.trim()) out.push(text)
        } catch (error) {
          logger.error('system-prompt segment failed', { name: seg.name, error: String(error) })
        }
      }
      out.push(
        [
          '## 环境信息',
          `- 工作目录 (cwd): ${cwd ?? process.cwd()}`,
          `- 操作系统: ${process.platform}`,
          `- 当前时间: ${new Date().toISOString()}`,
        ].join('\n'),
      )
      const md = discoverAgentsMd(cwd)
      if (md) out.push(`## 用户自定义指令\n\n${md}`)
      return out.join('\n\n')
    },
  }
  ctx.root.provide('systemPrompt', service)
}

void Object.assign(systemPromptPlugin, { inject: ['config'] })
