import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadApiKey } from './index'

describe('loadApiKey（specs/config.md 凭据优先级）', () => {
  let base: string
  const prevHome = process.env.HELUO_CODE_HOME

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'heluo-cred-'))
    process.env.HELUO_CODE_HOME = join(base, 'home')
    mkdirSync(process.env.HELUO_CODE_HOME!, { recursive: true })
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
    if (prevHome === undefined) delete process.env.HELUO_CODE_HOME
    else process.env.HELUO_CODE_HOME = prevHome
    delete process.env.HELUO_TEST_API_KEY
  })

  it('apiKeyEnv 环境变量优先于 credentials.json', () => {
    writeFileSync(join(process.env.HELUO_CODE_HOME!, 'credentials.json'), `{ "deepseek": "from-file" }`)
    process.env.HELUO_TEST_API_KEY = 'from-env'
    expect(loadApiKey('deepseek', 'HELUO_TEST_API_KEY')).toBe('from-env')
  })

  it('无 env 时回退读 credentials.json（JSONC 兼容）', () => {
    writeFileSync(
      join(process.env.HELUO_CODE_HOME!, 'credentials.json'),
      `// 本机凭据\n{ "deepseek": "file-key", /* 其它 */ "other": "x" }`,
    )
    expect(loadApiKey('deepseek')).toBe('file-key')
  })

  it('未配置的 provider 返回 undefined（不抛错）', () => {
    writeFileSync(join(process.env.HELUO_CODE_HOME!, 'credentials.json'), `{ "deepseek": "file-key" }`)
    expect(loadApiKey('qwen')).toBeUndefined()
  })

  it('无凭据文件返回 undefined', () => {
    expect(loadApiKey('deepseek')).toBeUndefined()
  })

  it('凭据文件损坏时静默返回 undefined', () => {
    writeFileSync(join(process.env.HELUO_CODE_HOME!, 'credentials.json'), `{ 非法 json`)
    expect(loadApiKey('deepseek')).toBeUndefined()
  })
})