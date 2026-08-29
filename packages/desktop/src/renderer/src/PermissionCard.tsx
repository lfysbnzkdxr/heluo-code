import type { JSX } from 'react'
import type { PendingPermission } from './session'

interface Props {
  permission: PendingPermission
  onDecision: (decision: 'allow' | 'deny' | 'always') => void
}

export default function PermissionCard({ permission, onDecision }: Props): JSX.Element {
  return (
    <div className="permission-card" data-testid="permission-card">
      <div className="permission-title">
        允许调用工具 <code>{permission.tool}</code>？
      </div>
      <pre className="permission-args">{permission.argsSummary}</pre>
      <div className="permission-actions">
        <button className="btn" data-testid="permission-allow" onClick={() => onDecision('allow')}>
          允许一次
        </button>
        <button className="btn" data-testid="permission-always" onClick={() => onDecision('always')}>
          总是允许
        </button>
        <button className="btn btn-danger" data-testid="permission-deny" onClick={() => onDecision('deny')}>
          拒绝
        </button>
      </div>
    </div>
  )
}