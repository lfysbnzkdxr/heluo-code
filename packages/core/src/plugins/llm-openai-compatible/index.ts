import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { streamText, jsonSchema, tool, type ToolSet } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { Context } from '@cordisjs/core'
import { isPlainObject, parseJsonc } from '../config/schema'
import type { AdapterFactory } from '../../services/llm/types'
import { normalizeFullStream } from '../../services/llm/normalize'

// 凭据解析（specs/config.md）：apiKeyEnv 环境变量 > ~/.heluo-code/credentials.json（JSONC: { providerId: apiKey }）
export function loadApiKey(providerId: string, apiKeyEnv?: string): string | undefined {
  if (apiKeyEnv) {
    const fromEnv = process.env[apiKeyEnv]
    if (fromEnv) return fromEnv
  }
  const home = process.env.HELUO_CODE_HOME ?? join(homedir(), '.heluo-code')
  try {
    const parsed = parseJsonc(readFileSync(join(home, 'credentials.json'), 'utf8'))
    if (isPlainObject(parsed)) {
      const value = parsed[providerId]
      if (typeof value === 'string' && value.length > 0) return value
    }
  } catch {
    /* 无凭据文件：返回 undefined，由上游报缺 key 错误 */
  }
  return undefined
}

function toAiTools(tools: { name: string; description: string; parameters: Record<string, unknown> }[]): ToolSet {
  const set: Record<string, ReturnType<typeof tool>> = {}
  for (const t of tools) {
    set[t.name] = tool({ description: t.description, inputSchema: jsonSchema(t.parameters) })
  }
  return set as ToolSet
}

const factory: AdapterFactory = (req, deps) => {
  const providerConfig = deps.providerConfig
  const apiKey = loadApiKey(req.adapterId, providerConfig?.apiKeyEnv)
  const provider = createOpenAICompatible({
    name: providerConfig?.type ?? 'openai-compatible',
    baseURL: providerConfig?.baseURL ?? 'https://api.openai.com/v1',
    apiKey,
  })
  const model = provider.languageModel(req.model)
  // AI SDK v7：system 消息不允许混入 messages，须经 instructions 选项传递（多条合并为一条）
  const instructions = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter((t) => t.length > 0)
    .join('\n\n')
  const messages = req.messages.filter((m) => m.role !== 'system')
  const result = streamText({
    model,
    messages,
    instructions: instructions || undefined,
    tools: toAiTools(req.tools),
    abortSignal: req.signal,
  })
  return normalizeFullStream(result.fullStream)
}

export function llmOpenAICompatiblePlugin(ctx: Context): void {
  ctx.root.llm!.registerAdapter('openai-compatible', factory)
}

void Object.assign(llmOpenAICompatiblePlugin, { inject: ['llm'] })
