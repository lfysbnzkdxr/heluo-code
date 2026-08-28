import { randomUUID } from 'node:crypto'
import type { Context } from '@cordisjs/core'
import type { TokenUsage } from '../../shared/events'
import { SessionError } from '../../shared/error'
import { logger } from '../../shared/logger'
import { deriveMessages, sumUsage } from '../session/derive'
import type { SessionStore } from '../session/store'
import type { ModelMessage } from 'ai'
import type { ModelRequest, ToolSchema } from '../llm/types'
import type { ToolOutcome } from '../tools/types'

export interface TurnResult {
  stopReason: 'completed' | 'interrupted' | 'error'
  usage?: TokenUsage
  error?: string
}

export interface OpenTurnOptions {
  session: SessionStore
  text: string
  signal?: AbortSignal
}

export interface AgentLoopService {
  createSession(cwd: string): SessionStore
  openTurn(opts: OpenTurnOptions): Promise<TurnResult>
  interrupt(sessionId: string): void
}

function splitModel(model: string): [string, string] {
  const idx = model.indexOf('/')
  if (idx < 0) return [model, model]
  return [model.slice(0, idx), model.slice(idx + 1)]
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

export function createAgentLoop(ctx: Context): AgentLoopService {
  const active = new Map<string, AbortController>()

  return {
    createSession(cwd: string) {
      return ctx.sessions!.create({ cwd })
    },
    interrupt(sessionId: string) {
      active.get(sessionId)?.abort()
    },
    async openTurn({ session, text, signal }: OpenTurnOptions): Promise<TurnResult> {
      if (active.has(session.id)) {
        throw new SessionError('会话忙，请先中断当前任务')
      }
      const controller = new AbortController()
      if (signal) {
        if (signal.aborted) controller.abort()
        else signal.addEventListener('abort', () => controller.abort(), { once: true })
      }
      active.set(session.id, controller)
      const mySignal = controller.signal

      const config = ctx.root.config?.get()
      const maxSteps = config?.loop.maxStepsPerTurn ?? 40
      const [adapterId, model] = splitModel(config?.model ?? '')
      const providerConfig = config?.providers[adapterId]
      const contextWindow = providerConfig?.contextWindow ?? 32000
      const softCap = Math.floor(contextWindow * 0.9)

      const turnId = randomUUID()
      let usage: TokenUsage | undefined
      let stopReason: TurnResult['stopReason'] = 'completed'
      let errorMsg: string | undefined

      session.append('turn/start', { turnId })
      session.append('user/message', { text })

      const system = ctx.root.systemPrompt?.getSystemPrompt(session.cwd) ?? ''

      try {
        for (let step = 0; step < maxSteps; step++) {
          if (mySignal.aborted) {
            stopReason = 'interrupted'
            break
          }
          const stepId = randomUUID()
          session.append('step/start', { stepId })

          const { messages, trimmed } = deriveMessages(session.getAll(), { softCapTokens: softCap })
          if (trimmed) logger.warn('session history trimmed to fit context window', { sessionId: session.id })
          const injects = session.takeInject()
          const injectMsgs = injects.map(
            (t): ModelMessage => ({ role: 'system', content: `[注入上下文] ${t}` }),
          )
          const tools: ToolSchema[] = ctx.root.tools!.getSchemaList()
          const fullMessages: ModelMessage[] = system
            ? [{ role: 'system', content: system }, ...injectMsgs, ...messages]
            : [...injectMsgs, ...messages]
          const req: ModelRequest = { adapterId, model, messages: fullMessages, tools, signal: mySignal }

          let textAccum = ''
          let stepUsage: TokenUsage | undefined
          const toolCalls: { id: string; name: string; argsJson: string }[] = []

          try {
            for await (const chunk of ctx.root.llm!.stream(req)) {
              if (chunk.type === 'text-delta') {
                textAccum += chunk.delta
                session.append('assistant/chunk', { stepId, delta: chunk.delta })
              } else if (chunk.type === 'reasoning-delta') {
                session.append('reasoning/chunk', { stepId, delta: chunk.delta })
              } else if (chunk.type === 'tool-call') {
                toolCalls.push(chunk.call)
                session.append('tool/call', { stepId, callId: chunk.call.id, name: chunk.call.name, args: safeParse(chunk.call.argsJson) })
              } else if (chunk.type === 'usage') {
                stepUsage = chunk.usage
              } else if (chunk.type === 'error') {
                throw chunk.error
              }
            }
          } catch (error) {
            if (mySignal.aborted) {
              stopReason = 'interrupted'
              session.append('step/end', { stepId })
              break
            }
            throw error
          }

          if (!mySignal.aborted && (textAccum !== '' || toolCalls.length > 0)) {
            session.append('assistant/message', { stepId, content: textAccum })
          }
          usage = sumUsage(usage, stepUsage)

          if (toolCalls.length === 0) {
            session.append('step/end', { stepId })
            break
          }

          for (const tc of toolCalls) {
            const started = Date.now()
            let result: ToolOutcome
            try {
              const args = safeParse(tc.argsJson)
              result = await ctx.root.tools!.execute(tc.name, args, {
                cwd: session.cwd,
                signal: mySignal,
                session,
                inject: (t: string) => session.inject(t),
              })
            } catch (error) {
              result = { ok: false, errorForModel: error instanceof Error ? error.message : String(error) }
            }
            session.append('tool/result', {
              callId: tc.id,
              output: result.ok ? result.outputForModel : result.errorForModel,
              isError: !result.ok,
              durationMs: Date.now() - started,
            })
          }
          session.append('step/end', { stepId })
        }
      } catch (error) {
        stopReason = 'error'
        errorMsg = error instanceof Error ? error.message : String(error)
        logger.error('turn failed', { sessionId: session.id, error: errorMsg })
      } finally {
        if (mySignal.aborted && stopReason === 'completed') stopReason = 'interrupted'
        session.append('turn/end', { turnId, stopReason, usage })
        active.delete(session.id)
      }

      return { stopReason, usage, error: errorMsg }
    },
  }
}
