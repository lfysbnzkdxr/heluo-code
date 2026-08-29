import { randomUUID } from 'node:crypto'
import type { Context } from '@cordisjs/core'
import { logger } from '../../shared/logger'

export type AgentStatus = 'idle' | 'running' | 'waiting-permission' | 'done' | 'failed'

export type AgentPermissionMode = 'ask' | 'agent' | 'quest'

export interface AgentDefinition {
  id: string
  systemPrompt: string
  tools?: string[]
  model?: string
  permissionMode?: AgentPermissionMode
}

export interface AgentHandle {
  id: string
  definitionId?: string
  task: string
  parentSessionId?: string
  sessionId: string
  status: AgentStatus
  summary?: string
  error?: string
  send(text: string): void
  interrupt(): void
  waitDone(): Promise<void>
  dispose(): Promise<void>
}

export interface CreateAgentOptions {
  definitionId?: string
  task: string
  parentSessionId?: string
  signal?: AbortSignal
}

export interface AgentFactoryOptions {
  ctx: Context
  handle: AgentHandle
  definition: AgentDefinition | undefined
  signal: AbortSignal
  emit(status: AgentStatus): void
}

export type AgentFactory = (opts: AgentFactoryOptions) => Promise<{ summary?: string; error?: string }>

export interface AgentService {
  setFactory(f: AgentFactory): () => void
  registerDefinition(def: AgentDefinition): () => void
  getDefinition(id: string): AgentDefinition | undefined
  create(opts: CreateAgentOptions): Promise<AgentHandle>
  get(id: string): AgentHandle | undefined
  list(): AgentHandle[]
  dispose(agentId: string): Promise<void>
  onStatusChange(cb: (handle: AgentHandle) => void): () => void
}

interface InternalHandle extends AgentHandle {
  controller: AbortController
  done: Promise<void>
  resolveDone(): void
  unlinkExternal(): void
  pendingSend: string[]
}

function linkSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => {}
  if (signal.aborted) {
    controller.abort()
    return () => {}
  }
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}

function defaultFactory({ ctx, handle, definition, signal, emit }: AgentFactoryOptions): Promise<{
  summary?: string
  error?: string
}> {
  return (async () => {
    const parent = handle.parentSessionId ? ctx.sessions!.get(handle.parentSessionId) : undefined
    const session = ctx.sessions!.create({ cwd: parent?.cwd ?? process.cwd() })
    handle.sessionId = session.sessionId
    // send() 窗口期缓冲（create 返回后至会话建立前的注入不丢失）
    for (const text of (handle as InternalHandle).pendingSend) session.inject(text)
    ;(handle as InternalHandle).pendingSend.length = 0

    const mode = definition?.permissionMode ?? ctx.permissions!.getEffectiveMode(handle.parentSessionId)
    ctx.permissions!.setSessionMode(session.sessionId, mode)

    const unsub = session.subscribe((ev) => {
      if (ev.type === 'permission/request') emit('waiting-permission')
      else if (ev.type === 'permission/response') emit('running')
    })

    try {
      const result = await ctx.agentLoop!.openTurn({
        session,
        text: handle.task,
        signal,
        systemPrompt: definition?.systemPrompt,
        toolAllowlist: definition?.tools,
        model: definition?.model,
      })
      if (result.stopReason === 'error') {
        return { error: result.error ?? '子 agent 运行失败' }
      }
      let summary: string | undefined
      for (let i = session.getAll().length - 1; i >= 0; i--) {
        const ev = session.getAll()[i]!
        if (ev.type === 'assistant/message' && ev.properties.content.trim() !== '') {
          summary = ev.properties.content
          break
        }
      }
      return { summary: summary ?? `（无文字结论，stopReason: ${result.stopReason}）` }
    } finally {
      unsub()
    }
  })()
}

export function agentsPlugin(ctx: Context): void {
  const definitions = new Map<string, AgentDefinition>()
  const handles = new Map<string, InternalHandle>()
  const queue: InternalHandle[] = []
  const statusListeners = new Set<(handle: AgentHandle) => void>()
  let factory: AgentFactory = defaultFactory
  let runningCount = 0

  function broadcast(handle: AgentHandle): void {
    for (const cb of statusListeners) cb(handle)
  }

  function setStatus(handle: InternalHandle, status: AgentStatus): void {
    if (handle.status === status) return
    handle.status = status
    broadcast(handle)
  }

  function maxConcurrency(): number {
    return ctx.root.config?.get()?.agents.maxConcurrency ?? 4
  }

  function startNext(): void {
    while (queue.length > 0 && runningCount < maxConcurrency()) {
      const handle = queue.shift()!
      void run(handle)
    }
  }

  async function run(handle: InternalHandle): Promise<void> {
    if (handle.status === 'done') return
    runningCount++
    setStatus(handle, 'running')
    try {
      const result = await factory({ ctx, handle, definition: handle.definitionId ? definitions.get(handle.definitionId) : undefined, signal: handle.controller.signal, emit: (s) => setStatus(handle, s) })
      handle.summary = result.summary
      handle.error = result.error
      setStatus(handle, result.error ? 'failed' : 'done')
    } catch (error) {
      handle.error = error instanceof Error ? error.message : String(error)
      logger.error('subagent failed', { agentId: handle.id, error: handle.error })
      setStatus(handle, 'failed')
    } finally {
      runningCount--
      handle.unlinkExternal()
      handle.resolveDone()
      startNext()
    }
  }

  const service: AgentService = {
    setFactory(f) {
      factory = f
      return () => {
        factory = defaultFactory
      }
    },
    registerDefinition(def) {
      definitions.set(def.id, def)
      return () => definitions.delete(def.id)
    },
    getDefinition(id) {
      return definitions.get(id)
    },
    async create(opts) {
      if (!opts.task.trim()) throw new Error('task 不能为空')
      const id = randomUUID()
      let resolveDone!: () => void
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve
      })
      const controller = new AbortController()
      const handle: InternalHandle = {
        id,
        definitionId: opts.definitionId,
        task: opts.task,
        parentSessionId: opts.parentSessionId,
        sessionId: '',
        status: 'idle',
        pendingSend: [],
        controller,
        done,
        resolveDone,
        unlinkExternal: () => {},
        send(text) {
          const session = ctx.root.sessions!.get(handle.sessionId)
          if (session) session.inject(text)
          else handle.pendingSend.push(text)
        },
        interrupt() {
          controller.abort()
        },
        waitDone: () => done,
        async dispose() {
          if (handle.sessionId) ctx.root.permissions!.clearSessionMode(handle.sessionId)
          const idx = queue.indexOf(handle)
          if (idx >= 0) {
            queue.splice(idx, 1)
            setStatus(handle, 'done')
            handle.unlinkExternal()
            handle.resolveDone()
            handles.delete(handle.id)
            return
          }
          controller.abort()
          await done.catch(() => {})
          handles.delete(handle.id)
        },
      }
      handle.unlinkExternal = linkSignal(opts.signal, controller)
      handles.set(id, handle)
      broadcast(handle)

      if (runningCount < maxConcurrency()) {
        void run(handle)
      } else {
        queue.push(handle)
        handle.controller.signal.addEventListener(
          'abort',
          () => {
            const idx = queue.indexOf(handle)
            if (idx < 0) return
            queue.splice(idx, 1)
            setStatus(handle, 'done')
            handle.unlinkExternal()
            handle.resolveDone()
            handles.delete(handle.id)
          },
          { once: true },
        )
      }
      return handle
    },
    get(id) {
      return handles.get(id)
    },
    list() {
      return [...handles.values()]
    },
    async dispose(agentId) {
      const handle = handles.get(agentId)
      if (!handle) return
      await handle.dispose()
    },
    onStatusChange(cb) {
      statusListeners.add(cb)
      return () => statusListeners.delete(cb)
    },
  }
  ctx.root.provide('agents', service)
  ctx.effect(() => service.registerDefinition(explorerDefinition))
}

void Object.assign(agentsPlugin, { inject: ['sessions', 'agentLoop', 'permissions', 'config'] })

export const explorerDefinition: AgentDefinition = {
  id: 'explorer',
  systemPrompt:
    '你是探索代理（explorer subagent），专注只读探索任务：定位文件、阅读代码、搜索内容。\n' +
    '只使用你的只读工具完成任务；完成后用一两句话总结发现，作为摘要回传给主代理。',
  tools: ['read_file', 'list_dir', 'grep_search'],
}