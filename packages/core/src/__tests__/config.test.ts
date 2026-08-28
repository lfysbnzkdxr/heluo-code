import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContext } from '../context'
import { configPlugin, buildConfig } from '../plugins/config'
import type { ConfigPluginOptions } from '../plugins/config'
import { parseJsonc, substituteEnv, mergeConfig } from '../plugins/config/schema'

describe('config primitives', () => {
  it('parseJsonc strips line/block comments and trailing commas', () => {
    const value = parseJsonc(`{
      // line comment
      "a": 1,
      /* block */ "b": [1, 2,],
    }`)
    expect(value).toEqual({ a: 1, b: [1, 2] })
  })

  it('substituteEnv replaces {env:VAR} from process.env', () => {
    process.env.HELUO_TEST_TOKEN = 'sekret'
    expect(substituteEnv({ url: 'https://x/{env:HELUO_TEST_TOKEN}' })).toEqual({
      url: 'https://x/sekret',
    })
  })

  it('mergeConfig deep-merges objects and overwrites arrays', () => {
    expect(
      mergeConfig({ a: { x: 1 }, list: [1, 2] }, { a: { y: 2 }, list: [3] }),
    ).toEqual({ a: { x: 1, y: 2 }, list: [3] })
  })
})

describe('buildConfig precedence', () => {
  let base: string
  const prevHome = process.env.HELUO_CODE_HOME

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'heluo-'))
    process.env.HELUO_CODE_HOME = join(base, 'global')
    mkdirSync(process.env.HELUO_CODE_HOME!, { recursive: true })
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
    if (prevHome === undefined) delete process.env.HELUO_CODE_HOME
    else process.env.HELUO_CODE_HOME = prevHome
  })

  it('override > project > global > default', async () => {
    writeFileSync(
      join(process.env.HELUO_CODE_HOME!, 'config.jsonc'),
      `{ "model": "global-model", "loop": { "maxStepsPerTurn": 5 } }`,
    )
    const projDir = join(base, 'project')
    mkdirSync(join(projDir, '.heluo-code'), { recursive: true })
    writeFileSync(
      join(projDir, '.heluo-code', 'config.jsonc'),
      `{ "model": "project-model" }`,
    )

    const config = buildConfig({ cwd: projDir }, { model: 'override-model' })
    expect(config.model).toBe('override-model')
    expect(config.loop.maxStepsPerTurn).toBe(5)
  })

  it('supports {env:VAR} substitution inside config files', async () => {
    process.env.HELUO_DEV_BASE = 'https://api.example.com'
    writeFileSync(
      join(process.env.HELUO_CODE_HOME!, 'config.jsonc'),
      `{ "providers": { "x": { "type": "openai-compatible", "baseURL": "{env:HELUO_DEV_BASE}" } } }`,
    )
    const config = buildConfig({ cwd: base })
    expect(config.providers.x?.baseURL).toBe('https://api.example.com')
  })

  it('parses provider contextWindow', async () => {
    writeFileSync(
      join(process.env.HELUO_CODE_HOME!, 'config.jsonc'),
      `{ "providers": { "x": { "type": "openai-compatible", "contextWindow": 65536 } } }`,
    )
    const config = buildConfig({ cwd: base })
    expect(config.providers.x?.contextWindow).toBe(65536)
  })

  it('throws ConfigError on invalid merged config', () => {
    writeFileSync(join(process.env.HELUO_CODE_HOME!, 'config.jsonc'), `{ "model": 123 }`)
    expect(() => buildConfig({ cwd: base })).toThrow()
  })

  it('registers config service onto ctx via plugin', async () => {
    const ctx = createContext()
    const options: ConfigPluginOptions = { profile: { cwd: base }, overrides: { model: 'svc-model' } }
    await ctx.plugin(configPlugin, options)
    expect(ctx.config?.get().model).toBe('svc-model')
    await ctx.fiber.dispose()
  })
})
