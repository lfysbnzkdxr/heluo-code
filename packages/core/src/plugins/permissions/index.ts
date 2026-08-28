import { randomUUID } from 'node:crypto'
import type { Context } from '@cordisjs/core'
import type { SessionHandle } from '../../services/tools/types'
import { logger } from '../../shared/logger'

export interface PermissionRequest {
  id: string
  tool: string
  argsSummary: string
}

export interface PermissionService {
  respond(requestId: string, decision: 'allow' | 'deny' | 'always'): void
  onRequest(cb: (req: PermissionRequest) => void): () => void
}

function summarize(args: unknown): string {
  const text = JSON.stringify(args)
  return text.length > 200 ? text.slice(0, 200) + '…' : text
}

export function permissionsPlugin(ctx: Context): void {
  const pending = new Map<string, { resolve: (d: 'allow' | 'deny' | 'always') => void; session: SessionHandle }>()
  const listeners = new Set<(req: PermissionRequest) => void>()

  const service: PermissionService = {
    respond(requestId, decision) {
      const entry = pending.get(requestId)
      if (!entry) return
      pending.delete(requestId)
      entry.resolve(decision)
    },
    onRequest(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
  ctx.root.provide('permissions', service)

  // 依据 SPEC specs/permissions.md 模式表：Ask 与 Agent(默认) 策略列完全相同
  // （read=allow / write=ask / run=ask），仅 Quest 对 ask 工具自动放行；二者等价为预期设计，非缺陷。
  const memory = new Map<string, Set<string>>() // sessionId -> 已 always 允许的 tool 集合

  ctx.tools!.onPreExecute(async ({ tool, args, tctx }) => {
    const policy = ctx.root.tools!.get(tool)?.permission
    if (policy !== 'ask') return 'allow'
    const mode = ctx.root.config?.get().permission.mode
    if (mode === 'quest') return 'allow'

    // always 记忆：同 session 内已 allow-always 的工具直接放行，不再弹确认
    const allowed = memory.get(tctx.session.id)
    if (allowed?.has(tool)) return 'allow'

    const id = randomUUID()
    const argsSummary = summarize(args)
    tctx.session.append('permission/request', { id, tool, argsSummary })
    for (const cb of listeners) cb({ id, tool, argsSummary })
    logger.info('permission request', { id, tool })

    const signal = tctx.signal
    if (signal?.aborted) return 'deny'
    let settled = false
    const decision = await new Promise<'allow' | 'deny' | 'always'>((resolve) => {
      const finish = (d: 'allow' | 'deny' | 'always') => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        pending.delete(id)
        resolve(d)
      }
      const onAbort = () => finish('deny')
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      pending.set(id, { resolve: finish, session: tctx.session })
    })
    tctx.session.append('permission/response', { id, decision })
    if (decision === 'always') {
      let set = memory.get(tctx.session.id)
      if (!set) {
        set = new Set()
        memory.set(tctx.session.id, set)
      }
      set.add(tool)
    }
    return decision === 'deny' ? 'deny' : 'allow'
  })
}

void Object.assign(permissionsPlugin, { inject: ['config', 'tools'] })
