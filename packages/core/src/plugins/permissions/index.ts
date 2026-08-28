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
  // always 记忆粒度（§8.4）：write/edit 按工具名；run_command 按「命令首 token 前缀」（如 npm/git 放行，rm/curl 仍问）
  const toolMemory = new Map<string, Set<string>>() // sessionId -> 已 always 的工具名集合
  const commandMemory = new Map<string, Set<string>>() // sessionId -> 已 always 的命令首 token（小写）集合

  function commandPrefix(args: unknown): string | null {
    const command = (args as { command?: unknown } | null)?.command
    if (typeof command !== 'string') return null
    const first = command.trim().split(/\s+/)[0]
    return first ? first.toLowerCase() : null
  }

  ctx.tools!.onPreExecute(async ({ tool, args, tctx }) => {
    const policy = ctx.root.tools!.get(tool)?.permission
    if (policy !== 'ask') return 'allow'
    const config = ctx.root.config?.get()
    const mode = config?.permission.mode
    if (mode === 'quest') {
      // Quest 对 ask 工具自动放行；run_command 按 questRunCommand 配置（默认 ask）
      if (tool !== 'run_command' || config?.permission.questRunCommand === 'allow') return 'allow'
    }

    // always 记忆：同 session 内已 always 的工具/命令前缀直接放行，不再弹确认
    const allowedTools = toolMemory.get(tctx.session.id)
    if (allowedTools?.has(tool)) return 'allow'
    if (tool === 'run_command') {
      const prefix = commandPrefix(args)
      if (prefix && commandMemory.get(tctx.session.id)?.has(prefix)) return 'allow'
    }

    const id = randomUUID()
    const argsSummary = summarize(args)
    const signal = tctx.signal

    // 先注册 pending 再广播：同步响应的消费者（事件订阅/onRequest 直接 respond）
    // 在广播后立即 respond 也必须命中，否则响应静默丢失导致挂起
    let settled = false
    let resolveDecision!: (d: 'allow' | 'deny' | 'always') => void
    const finish = (d: 'allow' | 'deny' | 'always') => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      pending.delete(id)
      resolveDecision(d)
    }
    const onAbort = () => finish('deny')
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    const decisionPromise = new Promise<'allow' | 'deny' | 'always'>((resolve) => {
      resolveDecision = resolve
      pending.set(id, { resolve: finish, session: tctx.session })
    })

    tctx.session.append('permission/request', { id, tool, argsSummary })
    for (const cb of listeners) cb({ id, tool, argsSummary })
    logger.info('permission request', { id, tool })

    if (signal?.aborted) finish('deny')
    const decision = await decisionPromise
    tctx.session.append('permission/response', { id, decision })
    if (decision === 'always') {
      if (tool === 'run_command') {
        const prefix = commandPrefix(args)
        if (prefix) {
          let set = commandMemory.get(tctx.session.id)
          if (!set) {
            set = new Set()
            commandMemory.set(tctx.session.id, set)
          }
          set.add(prefix)
        }
      } else {
        let set = toolMemory.get(tctx.session.id)
        if (!set) {
          set = new Set()
          toolMemory.set(tctx.session.id, set)
        }
        set.add(tool)
      }
    }
    return decision === 'deny' ? 'deny' : 'allow'
  })
}

void Object.assign(permissionsPlugin, { inject: ['config', 'tools'] })
