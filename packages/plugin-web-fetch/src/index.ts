import type { Context, ToolDefinition, ToolOutcome } from '@heluo-code/core'

const MAX_OUTPUT_CHARS = 50000
const DEFAULT_TIMEOUT_MS = 15000

function extractText(contentType: string | undefined, body: string): string {
  if (contentType?.includes('html')) {
    return body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return body
}

export const webFetchPlugin = {
  name: 'web-fetch',
  inject: ['tools'],
  apply(ctx: Context): void {
    const tool: ToolDefinition = {
      name: 'web_fetch',
      description: '抓取指定 URL 的网页内容并返回纯文本（HTML 标签已剥离）。仅支持 http/https。',
      permission: 'allow',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的完整 URL（http/https）' },
        },
        required: ['url'],
      },
      async execute(args: unknown, tctx): Promise<ToolOutcome> {
        const { url } = (args ?? {}) as { url?: unknown }
        if (typeof url !== 'string' || url.length === 0) {
          return { ok: false, errorForModel: 'web_fetch: 缺少 url 参数' }
        }
        if (!/^https?:\/\//i.test(url)) {
          return { ok: false, errorForModel: 'web_fetch: 仅支持 http/https URL' }
        }
        if (tctx.signal.aborted) return { ok: false, errorForModel: 'web_fetch: 操作已取消' }
        try {
          const response = await fetch(url, {
            redirect: 'follow',
            signal: AbortSignal.any([tctx.signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)]),
          })
          if (!response.ok) {
            return { ok: false, errorForModel: `web_fetch: HTTP ${response.status} ${response.statusText}` }
          }
          const body = await response.text()
          const content = extractText(response.headers.get('content-type') ?? undefined, body)
          if (content.length > MAX_OUTPUT_CHARS) {
            return {
              ok: true,
              outputForModel: content.slice(0, MAX_OUTPUT_CHARS) + '\n…[web_fetch 输出过长已截断]',
            }
          }
          return { ok: true, outputForModel: content || '（空响应）' }
        } catch (error) {
          if (tctx.signal.aborted) return { ok: false, errorForModel: 'web_fetch: 操作已取消' }
          return {
            ok: false,
            errorForModel: `web_fetch: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
      },
    }
    ctx.effect(() => ctx.root.tools!.register(tool))
  },
}

export default webFetchPlugin