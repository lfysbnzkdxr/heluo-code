import type { JSX } from 'react'
import type { AgentInfo } from '../../shared/ipc'

const STATUS_LABEL: Record<AgentInfo['status'], string> = {
  idle: '排队中',
  running: '运行中',
  'waiting-permission': '等待授权',
  done: '完成',
  failed: '失败',
}

interface Props {
  agents: AgentInfo[]
  onInterrupt(agentId: string): void
  onPermission(requestId: string, decision: 'allow' | 'deny' | 'always'): void
}

export default function AgentBoard({ agents, onInterrupt, onPermission }: Props): JSX.Element {
  if (agents.length === 0) return <></>
  return (
    <div className="agent-board" data-testid="agent-board">
      <div className="agent-board-head">子代理看板</div>
      {agents.map((a) => (
        <div key={a.id} className="agent-card" data-testid="agent-card">
          <div className="agent-card-head">
            <span className="agent-card-task" title={a.task}>
              {a.task}
            </span>
            {a.definitionId && <span className="agent-card-def">{a.definitionId}</span>}
            <span className={`agent-status agent-status-${a.status}`}>{STATUS_LABEL[a.status]}</span>
          </div>
          {(a.status === 'done' || a.status === 'failed') && (
            <div
              className={`agent-card-result${a.status === 'failed' ? ' agent-card-error' : ''}`}
              data-testid="agent-card-result"
            >
              {a.status === 'failed' ? (a.error ?? '失败') : (a.summary ?? '')}
            </div>
          )}
          {a.pendingPermission && (
            <div className="agent-perm" data-testid="agent-perm">
              <span className="agent-perm-tool">{a.pendingPermission.tool}</span>
              <span className="agent-perm-args">{a.pendingPermission.argsSummary}</span>
              <div className="agent-perm-actions">
                <button
                  className="btn"
                  data-testid="agent-perm-allow"
                  onClick={() => onPermission(a.pendingPermission!.id, 'allow')}
                >
                  允许
                </button>
                <button
                  className="btn"
                  data-testid="agent-perm-always"
                  onClick={() => onPermission(a.pendingPermission!.id, 'always')}
                >
                  始终允许
                </button>
                <button
                  className="btn btn-danger"
                  data-testid="agent-perm-deny"
                  onClick={() => onPermission(a.pendingPermission!.id, 'deny')}
                >
                  拒绝
                </button>
              </div>
            </div>
          )}
          {(a.status === 'running' || a.status === 'waiting-permission') && (
            <button className="btn btn-danger agent-interrupt" data-testid="agent-interrupt" onClick={() => onInterrupt(a.id)}>
              中断
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
