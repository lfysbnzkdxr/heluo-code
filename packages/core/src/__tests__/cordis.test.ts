import { describe, expect, it } from 'vitest'
import type { Context } from '@cordisjs/core'
import { createContext } from '../context'

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
})
