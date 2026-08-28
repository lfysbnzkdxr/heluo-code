import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertGlobalOnly } from './index'

describe('assertGlobalOnly（providers/plugins 安全边界）', () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'heluo-global-'))
  })
  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('项目级配置含 providers 时报错', () => {
    expect(() => assertGlobalOnly({ providers: { x: { type: 'openai-compatible' } } }, 'proj/config.jsonc')).toThrow()
  })

  it('项目级配置含 plugins 时报错', () => {
    expect(() => assertGlobalOnly({ plugins: ['foo'] }, 'proj/config.jsonc')).toThrow()
  })

  it('普通字段与空对象不报错', () => {
    expect(() => assertGlobalOnly({ model: 'x' }, 'proj/config.jsonc')).not.toThrow()
    expect(() => assertGlobalOnly({}, 'proj/config.jsonc')).not.toThrow()
  })
})
