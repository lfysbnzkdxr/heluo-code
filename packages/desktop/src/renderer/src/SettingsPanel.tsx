import { useState } from 'react'
import type { JSX } from 'react'
import type { ConfigSnapshot } from '../../shared/ipc'

interface Props {
  config: ConfigSnapshot
  onClose(): void
  onModelSaved(model: string): Promise<void>
  onApiKeySaved(providerId: string, apiKey: string): Promise<void>
}

// 设置页：provider/model 选择 + API Key 写 credentials.json（经 IPC 交 main 落盘，renderer 不持有 key）。
export default function SettingsPanel({ config, onClose, onModelSaved, onApiKeySaved }: Props): JSX.Element {
  const [model, setModel] = useState(config.model)
  const [providerId, setProviderId] = useState(config.providers[0]?.id ?? '')
  const [apiKey, setApiKey] = useState('')
  const [saved, setSaved] = useState('')
  const [error, setError] = useState('')

  const saveModel = async (): Promise<void> => {
    try {
      await onModelSaved(model.trim())
      setSaved('模型已保存，下一条任务生效')
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const saveApiKey = async (): Promise<void> => {
    if (!providerId || !apiKey.trim()) {
      setError('请选择 provider 并输入 API Key')
      return
    }
    try {
      await onApiKeySaved(providerId, apiKey.trim())
      setApiKey('')
      setSaved(`凭据已写入 credentials.json（${providerId}）`)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="settings-overlay" data-testid="settings-panel">
      <div className="settings-panel">
        <div className="settings-head">
          <span>设置</span>
          <button className="btn" onClick={onClose} data-testid="settings-close">
            关闭
          </button>
        </div>

        <label className="settings-field">
          模型（格式: providerId/modelName）
          <input
            className="composer-input"
            value={model}
            placeholder="如 deepseek/deepseek-chat"
            onChange={(e) => setModel(e.target.value)}
            data-testid="settings-model"
          />
        </label>
        <button className="btn" onClick={saveModel} data-testid="settings-save-model">
          保存模型
        </button>

        <label className="settings-field">
          Provider（API Key 归属）
          <select className="composer-input" value={providerId} onChange={(e) => setProviderId(e.target.value)} data-testid="settings-provider">
            {config.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} ({p.type})
              </option>
            ))}
          </select>
        </label>
        <label className="settings-field">
          API Key（写入 credentials.json，仅存于本机）
          <input
            className="composer-input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            data-testid="settings-api-key"
          />
        </label>
        <button className="btn" onClick={saveApiKey} data-testid="settings-save-key">
          保存 API Key
        </button>

        {saved && <div className="settings-hint settings-hint-ok">{saved}</div>}
        {error && <div className="settings-hint settings-hint-error">{error}</div>}
      </div>
    </div>
  )
}