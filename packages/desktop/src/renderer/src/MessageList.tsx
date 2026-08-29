import type { JSX } from 'react'
import DiffView from './DiffView'
import type { ReasoningBlock, ToolCard, UiMessage } from './session'

interface Props {
  messages: UiMessage[]
  toolCards: ToolCard[]
  reasonings: ReasoningBlock[]
}

export default function MessageList({ messages, toolCards, reasonings }: Props): JSX.Element {
  return (
    <div className="message-list">
      {messages.map((m) => {
        const reasoning = m.role === 'assistant' ? reasonings.find((r) => r.stepId === m.id) : undefined
        const message = (
          <div className={`message message-${m.role}`} data-testid={`message-${m.role}`}>
            <div className="message-label">{m.role === 'user' ? '你' : 'AI'}</div>
            <div className="message-content">{m.content}</div>
          </div>
        )
        return reasoning ? (
          <div key={m.id} className="message-group">
            <ReasoningBlock block={reasoning} />
            {message}
          </div>
        ) : (
          <div key={m.id}>{message}</div>
        )
      })}
      {toolCards.map((c) => (
        <div key={c.callId} className={`tool-card tool-card-${c.status}`} data-testid="tool-card">
          <div className="tool-card-head">
            <span className="tool-card-name">{c.name}</span>
            <span className={`tool-card-status tool-card-status-${c.status}`}>
              {c.status === 'running' ? '执行中' : c.status === 'error' ? '失败' : '完成'}
            </span>
          </div>
          <pre className="tool-card-args">{c.args}</pre>
          {c.status === 'running' && c.stream ? (
            <pre className="tool-card-output" data-testid="tool-card-stream">
              {c.stream}
            </pre>
          ) : (
            c.output && <pre className="tool-card-output">{c.output}</pre>
          )}
          {c.status === 'done' && c.diff && <DiffView diff={c.diff} />}
        </div>
      ))}
    </div>
  )
}

function ReasoningBlock({ block }: { block: ReasoningBlock }): JSX.Element {
  return (
    <details className="reasoning-block" data-testid="reasoning-block">
      <summary>思考过程</summary>
      <pre className="reasoning-content">{block.content}</pre>
    </details>
  )
}