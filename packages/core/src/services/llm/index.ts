import type { Context } from '@cordisjs/core'
import { LlmError } from '../../shared/error'
import type { AdapterFactory, LlmService } from './types'

export type { AdapterFactory, LlmService, ModelRequest, StreamChunk, ToolSchema } from './types'

function llmPlugin(ctx: Context): void {
  const adapters = new Map<string, AdapterFactory>()
  const config = ctx.root.config

  const service: LlmService = {
    registerAdapter(id, factory) {
      adapters.set(id, factory)
      return () => adapters.delete(id)
    },
    stream(req) {
      const providerConfig = config?.get().providers[req.adapterId]
      const kind = providerConfig?.type ?? req.adapterId
      const factory = adapters.get(kind)
      if (!factory) {
        throw new LlmError(`未注册 LLM 适配器: ${kind}（model=${req.adapterId}/${req.model}）`)
      }
      return factory(req, { providerConfig })
    },
  }
  ctx.root.provide('llm', service)
}

export { llmPlugin }
void Object.assign(llmPlugin, { inject: ['config'] })

