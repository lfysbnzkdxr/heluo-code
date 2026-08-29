import type { JSX } from 'react'
import type { ToolCard, UiMessage } from './session'

interface Props {
  messages: UiMessage[]
  toolCards: ToolCard[]
}

export default function MessageList({ messages, toolCards }: Props): JSX.Element {
  return (
    <div className="message-list">
      {messages.map((m) => (
        <div key={m.id} className={`message message-${m.role}`} data-testid={`message-${m.role}`}>
          <div className="message-label">{m.role === 'user' ? '你' : 'AI'}</div>
          <div className="message-content">{m.content}</div>
        </div>
      ))}
      {toolCards.map((c) => (
        <div key={c.callId} className={`tool-card tool-card-${c.status}`} data-testid="tool-card">
          <div className="tool-card-head">
            <span className="tool-card-name">{c.name}</span>
            <span className={`tool-card-status tool-card-status-${c.status}`}>
              {c.status === 'running' ? '执行中' : c.status === 'error' ? '失败' : '完成'}
            </span>
          </div>
          <pre className="tool-card-args">{c.args}</pre>
          {c.output && <pre className="tool-card-output">{c.output}</pre>}
        </div>
      ))}
    </div>
  )
}