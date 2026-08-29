import type { JSX } from 'react'
import type { SessionInfo } from '../../shared/ipc'

interface Props {
  sessions: SessionInfo[]
  onCreate(): void
  onSwitch(sessionId: string): void
}

// 会话侧栏（P4b）：多会话列表（cwd + 激活态）+ 新建；会话绑定 cwd，切换保留历史。
export default function SessionSidebar({ sessions, onCreate, onSwitch }: Props): JSX.Element {
  return (
    <aside className="sidebar" data-testid="session-sidebar">
      <div className="sidebar-head">
        <span>会话</span>
        <button className="btn" onClick={onCreate} data-testid="session-create">
          ＋
        </button>
      </div>
      <div className="session-list">
        {sessions.map((s) => (
          <button
            key={s.id}
            className={`session-item ${s.active ? 'session-item-active' : ''}`}
            onClick={() => onSwitch(s.id)}
            title={s.cwd}
            data-testid="session-item"
          >
            <span className="session-cwd">{s.cwd}</span>
            {s.active && <span className="session-active-mark">●</span>}
          </button>
        ))}
      </div>
    </aside>
  )
}