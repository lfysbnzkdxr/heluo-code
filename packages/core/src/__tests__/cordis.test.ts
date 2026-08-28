import { describe, expect, it } from 'vitest'
import type { Context } from '@cordisjs/core'
import { createContext } from '../context'
import { toolsPlugin } from '../services/tools'

describe('cordis smoke', () => {
  it('mounts a plugin and disposes reversible effects in reverse order', async () => {
    const ctx = createContext()
    const log: string[] = []

    const fiber = await ctx.plugin((c: Context) => {
      log.push('applied')
      c.effect(() => {
        log.push('effect-a')
        return () => log.push('dispose-a')
      })
      c.effect(() => {
        log.push('effect-b')
        return () => log.push('dispose-b')
      })
    })

    expect(log).toEqual(['applied', 'effect-a', 'effect-b'])
    await fiber.dispose()
    expect(log).toEqual(['applied', 'effect-a', 'effect-b', 'dispose-b', 'dispose-a'])
  })

  it('inject 依赖乱序挂载时等待依赖就绪（Cordis 消费 inject 声明）', async () => {
    const ctx = createContext()
    const log: string[] = []
    let sawTools = false

    const consumer = (c: Context) => {
      log.push('consumer-applied')
      sawTools = c.tools !== undefined
    }
    void Object.assign(consumer, { inject: ['tools'] })

    await ctx.plugin(consumer)
    await ctx.plugin(toolsPlugin)

    expect(log).toContain('consumer-applied')
    expect(sawTools).toBe(true)
    await ctx.fiber.dispose()
  })
})
