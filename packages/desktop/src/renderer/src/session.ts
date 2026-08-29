import type { SessionEvent } from '@heluo-code/core'

export interface UiMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

export interface ToolCard {
  callId: string
  name: string
  args: string
  status: 'running' | 'done' | 'error'
  output: string
}

export interface PendingPermission {
  id: string
  tool: string
  argsSummary: string
}

export interface UiState {
  messages: UiMessage[]
  toolCards: ToolCard[]
  pendingPermission: PendingPermission | null
  turnStatus: 'idle' | 'running' | 'waiting-permission'
  lastTurnEnd: { stopReason: string } | null
}

export function createInitialState(): UiState {
  return {
    messages: [],
    toolCards: [],
    pendingPermission: null,
    turnStatus: 'idle',
    lastTurnEnd: null,
  }
}

// 纯 reducer：SessionEvent 流 → UI 状态。事件是 append-only 日志，
// 从空状态重放全量事件即得 UI 状态（刷新重同步与实时增量走同一条路径）。
export function reduceEvent(state: UiState, ev: SessionEvent): UiState {
  switch (ev.type) {
    case 'user/message':
      return { ...state, messages: [...state.messages, { id: ev.id, role: 'user', content: ev.properties.text }] }
    case 'assistant/chunk': {
      const stepId = ev.properties.stepId
      const messages = state.messages.slice()
      const idx = messages.findLastIndex((m) => m.role === 'assistant' && m.id === stepId)
      if (idx >= 0) {
        messages[idx] = { ...messages[idx]!, content: messages[idx]!.content + ev.properties.delta }
      } else {
        messages.push({ id: stepId, role: 'assistant', content: ev.properties.delta })
      }
      return { ...state, messages }
    }
    case 'assistant/message': {
      // chunk 已累积过则跳过（防重复）；刷新快照只有落定消息时兜底补一条
      if (state.messages.some((m) => m.id === ev.properties.stepId)) return state
      return { ...state, messages: [...state.messages, { id: ev.properties.stepId, role: 'assistant', content: ev.properties.content }] }
    }
    case 'tool/call': {
      const args = typeof ev.properties.args === 'string' ? ev.properties.args : JSON.stringify(ev.properties.args)
      return {
        ...state,
        toolCards: [...state.toolCards, { callId: ev.properties.callId, name: ev.properties.name, args, status: 'running', output: '' }],
      }
    }
    case 'tool/result': {
      const toolCards = state.toolCards.map((c) =>
        c.callId === ev.properties.callId
          ? { ...c, status: ev.properties.isError ? ('error' as const) : ('done' as const), output: ev.properties.output }
          : c,
      )
      return { ...state, toolCards }
    }
    case 'permission/request':
      return {
        ...state,
        pendingPermission: { id: ev.properties.id, tool: ev.properties.tool, argsSummary: ev.properties.argsSummary },
        turnStatus: 'waiting-permission',
      }
    case 'permission/response': {
      if (state.pendingPermission?.id !== ev.properties.id) return state
      return { ...state, pendingPermission: null, turnStatus: state.turnStatus === 'idle' ? 'idle' : 'running' }
    }
    case 'turn/start':
      return { ...state, turnStatus: 'running' }
    case 'turn/end':
      return { ...state, turnStatus: 'idle', pendingPermission: null, lastTurnEnd: { stopReason: ev.properties.stopReason } }
    case 'reasoning/chunk':
    case 'step/start':
    case 'step/end':
    case 'tool/stream':
      return state
  }
}

export type UiAction = { type: 'replace'; state: UiState } | { type: 'event'; event: SessionEvent }

export function reducer(state: UiState, action: UiAction): UiState {
  return action.type === 'replace' ? action.state : reduceEvent(state, action.event)
}

export function replay(events: SessionEvent[]): UiState {
  return events.reduce(reduceEvent, createInitialState())
}