import { streamText, jsonSchema, tool, type ToolSet } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { Context } from '@cordisjs/core'
import type { AdapterFactory } from '../../services/llm/types'
import { normalizeFullStream } from '../../services/llm/normalize'

function toAiTools(tools: { name: string; description: string; parameters: Record<string, unknown> }[]): ToolSet {
  const set: Record<string, ReturnType<typeof tool>> = {}
  for (const t of tools) {
    set[t.name] = tool({ description: t.description, inputSchema: jsonSchema(t.parameters) })
  }
  return set as ToolSet
}

const factory: AdapterFactory = (req, deps) => {
  const providerConfig = deps.providerConfig
  const apiKey = providerConfig?.apiKeyEnv ? process.env[providerConfig.apiKeyEnv] : undefined
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
