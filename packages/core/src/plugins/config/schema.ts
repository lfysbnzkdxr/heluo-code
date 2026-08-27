import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { ConfigError } from '../../shared/error'

export const providerConfigSchema = z.object({
  type: z.string(),
  baseURL: z.string().optional(),
  models: z.array(z.string()).optional(),
  apiKeyEnv: z.string().optional(),
})

export const configSchema = z.object({
  model: z.string(),
  providers: z.record(z.string(), providerConfigSchema),
  plugins: z.array(z.string()),
  permission: z.object({
    mode: z.enum(['ask', 'agent', 'quest']),
  }),
  loop: z.object({
    maxStepsPerTurn: z.number().int().positive(),
  }),
  rules: z.array(z.string()),
  tools: z.object({
    exclude: z.array(z.string()),
    grepMaxResults: z.number().int().nonnegative(),
    outputTruncateHead: z.number().int().nonnegative(),
    outputTruncateTail: z.number().int().nonnegative(),
  }),
})

export const defaultConfig = {
  model: '',
  providers: {},
  plugins: [],
  permission: { mode: 'agent' as const },
  loop: { maxStepsPerTurn: 40 },
  rules: [],
  tools: {
    exclude: [],
    grepMaxResults: 100,
    outputTruncateHead: 500,
    outputTruncateTail: 500,
  },
}

export type Config = z.infer<typeof configSchema>

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function mergeConfig(base: unknown, override: unknown): unknown {
  if (override === undefined) return base
  if (Array.isArray(base) || Array.isArray(override)) return override
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...base }
    for (const key of Object.keys(override)) {
      out[key] = mergeConfig(base[key], override[key])
    }
    return out
  }
  return override
}

export function stripComments(text: string): string {
  let out = ''
  let inString: string | null = null
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === inString) inString = null
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = ch
      out += ch
      i++
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripComments(text))
}

export function substituteEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{env:([A-Za-z0-9_]+)\}/g, (_, name: string) => process.env[name] ?? '')
  }
  if (Array.isArray(value)) return value.map(substituteEnv)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) out[key] = substituteEnv(val)
    return out
  }
  return value
}

export function loadOptional(path: string): unknown {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  try {
    return substituteEnv(parseJsonc(raw))
  } catch {
    throw new ConfigError(`failed to parse config file: ${path}`)
  }
}
