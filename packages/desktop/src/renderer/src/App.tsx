import { useEffect, useReducer, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { ConfigSnapshot, PermissionMode, SessionInfo, AgentInfo } from '../../shared/ipc'
import { createInitialState, reducer, replay } from './session'
import type { UiState } from './session'
import MessageList from './MessageList'
import PermissionCard from './PermissionCard'
import SessionSidebar from './SessionSidebar'
import SettingsPanel from './SettingsPanel'
import AgentBoard from './AgentBoard'

const STATUS_LABEL: Record<UiState['turnStatus'], string> = {
  idle: '空闲',
  running: '运行中',
  'waiting-permission': '等待授权',
}

const MODE_LABEL: Record<PermissionMode, string> = {
  ask: 'Ask',
  agent: 'Agent',
  quest: 'Quest',
}

export default function App(): JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState)
  const [cwd, setCwd] = useState('')
  const [input, setInput] = useState('')
  const [config, setConfig] = useState<ConfigSnapshot | null>(null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const sessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    let disposed = false
    void window.heluo.getSnapshot().then(({ sessionId, cwd, events, sessions, agents }) => {
      if (disposed) return
      dispatch({ type: 'replace', state: replay(events) })
      sessionIdRef.current = sessionId
      setCwd(cwd)
      setSessions(sessions)
      setAgents(agents)
    })
    void window.heluo.getConfig().then((cfg) => {
      if (!disposed) setConfig(cfg)
    })
    const unsubscribe = window.heluo.onEvent((msg) => {
      if (msg.type === 'session-event') {
        dispatch({ type: 'event', event: msg.event })
        sessionIdRef.current ??= msg.event.sessionId
      } else if (msg.type === 'cwd-changed') {
        setCwd(msg.cwd)
      } else if (msg.type === 'sessions-changed') {
        setSessions(msg.sessions)
        const active = msg.sessions.find((s) => s.active)
        if (active && active.id !== sessionIdRef.current) {
          // 切换会话：重拉快照全量重放新会话历史（事件流只含 active 会话，不串事件）
          void window.heluo.getSnapshot().then((snap) => {
            dispatch({ type: 'replace', state: replay(snap.events) })
            sessionIdRef.current = snap.sessionId
            setCwd(snap.cwd)
          })
        }
      } else {
        setAgents(msg.agents)
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

  const switchMode = (mode: PermissionMode): void => {
    void window.heluo.setConfig({ permissionMode: mode }).then(() => {
      setConfig((c) => (c ? { ...c, permissionMode: mode } : c))
    }).catch(() => {
      /* UI 仅发送合法枚举；异常（如 config 未挂载）不产生未处理拒绝 */
    })
  }

  const saveModel = async (model: string): Promise<void> => {
    await window.heluo.setConfig({ model })
    setConfig((c) => (c ? { ...c, model } : c))
  }

  const saveApiKey = async (providerId: string, apiKey: string): Promise<void> => {
    await window.heluo.setCredentials(providerId, apiKey)
  }

  const createSession = (): void => {
    window.heluo.submit({ type: 'create-session' })
  }

  const switchSession = (targetId: string): void => {
    window.heluo.submit({ type: 'switch-session', sessionId: targetId })
  }

  return (
    <div className="app">
      <SessionSidebar sessions={sessions} onCreate={createSession} onSwitch={switchSession} />
      <div className="app-main">
        <header className="topbar">
          <span className="cwd" title={cwd}>
            {cwd || '（未选择工作目录）'}
          </span>
          {config && (
            <div className="mode-switch" data-testid="mode-switch">
              {(['ask', 'agent', 'quest'] as const).map((m) => (
                <button
                  key={m}
                  className={`mode-btn ${config.permissionMode === m ? 'mode-btn-active' : ''}`}
                  onClick={() => switchMode(m)}
                  data-testid={`mode-${m}`}
                >
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
          )}
          <button className="btn" onClick={() => setShowSettings(true)} data-testid="settings-button">
            设置
          </button>
          <button className="btn" onClick={pickCwd} disabled={busy}>
            更换目录
          </button>
          <span className={`status status-${state.turnStatus}`}>{STATUS_LABEL[state.turnStatus]}</span>
          {state.lastTurnEnd?.usage && (
            <span
              className="token-badge"
              data-testid="token-badge"
              title={`输入 ${state.lastTurnEnd.usage.promptTokens} / 输出 ${state.lastTurnEnd.usage.completionTokens}`}
            >
              tokens {state.lastTurnEnd.usage.totalTokens}
            </span>
          )}
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
          <MessageList messages={state.messages} toolCards={state.toolCards} reasonings={state.reasonings} />
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

        <AgentBoard
          agents={agents}
          onInterrupt={(agentId) => window.heluo.submit({ type: 'agent-interrupt', agentId })}
          onPermission={(requestId, decision) => window.heluo.submit({ type: 'permission-decision', requestId, decision })}
        />

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

      {showSettings && config && (
        <SettingsPanel config={config} onClose={() => setShowSettings(false)} onModelSaved={saveModel} onApiKeySaved={saveApiKey} />
      )}
    </div>
  )
}
