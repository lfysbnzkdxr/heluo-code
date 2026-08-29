import { useEffect, useReducer, useRef, useState } from 'react'
import type { JSX } from 'react'
import { createInitialState, reducer, replay } from './session'
import type { UiState } from './session'
import MessageList from './MessageList'
import PermissionCard from './PermissionCard'

const STATUS_LABEL: Record<UiState['turnStatus'], string> = {
  idle: '空闲',
  running: '运行中',
  'waiting-permission': '等待授权',
}

export default function App(): JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState)
  const [cwd, setCwd] = useState('')
  const [input, setInput] = useState('')
  const sessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    let disposed = false
    void window.heluo.getSnapshot().then(({ sessionId, cwd, events }) => {
      if (disposed) return
      dispatch({ type: 'replace', state: replay(events) })
      sessionIdRef.current = sessionId
      setCwd(cwd)
    })
    const unsubscribe = window.heluo.onEvent((msg) => {
      if (msg.type === 'session-event') {
        dispatch({ type: 'event', event: msg.event })
        sessionIdRef.current ??= msg.event.sessionId
      } else {
        setCwd(msg.cwd)
      }
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  const busy = state.turnStatus !== 'idle'
  const sessionId = sessionIdRef.current

  const submit = (): void => {
    const text = input.trim()
    if (!text || busy || !sessionId) return
    window.heluo.submit({ type: 'user-turn', sessionId, text })
    setInput('')
  }

  const stop = (): void => {
    if (!sessionId) return
    window.heluo.submit({ type: 'interrupt', sessionId })
  }

  const pickCwd = (): void => {
    void window.heluo.pickCwd()
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="cwd" title={cwd}>
          {cwd || '（未选择工作目录）'}
        </span>
        <button className="btn" onClick={pickCwd} disabled={busy}>
          更换目录
        </button>
        <span className={`status status-${state.turnStatus}`}>{STATUS_LABEL[state.turnStatus]}</span>
        {state.lastTurnEnd && (
          <span className="last-turn" data-testid="last-turn-end">
            上次: {state.lastTurnEnd.stopReason}
          </span>
        )}
        {busy && (
          <button className="btn btn-stop" onClick={stop} data-testid="stop-button">
            停止
          </button>
        )}
      </header>

      <main className="chat">
        <MessageList messages={state.messages} toolCards={state.toolCards} />
        {state.pendingPermission && (
          <PermissionCard
            permission={state.pendingPermission}
            onDecision={(decision) => {
              if (!sessionId) return
              window.heluo.submit({ type: 'permission-decision', requestId: state.pendingPermission!.id, decision })
            }}
          />
        )}
      </main>

      <footer className="composer">
        <input
          className="composer-input"
          value={input}
          placeholder={busy ? '任务进行中…' : '输入任务，Enter 发送'}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          data-testid="composer-input"
        />
        <button className="btn btn-primary" onClick={submit} disabled={busy || !input.trim()} data-testid="send-button">
          发送
        </button>
      </footer>
    </div>
  )
}