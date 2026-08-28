type Level = 'debug' | 'info' | 'warn' | 'error'

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function current(): Level {
  const raw = process.env.HELUO_CODE_LOG_LEVEL
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info'
}

export function log(level: Level, message: string, ...args: unknown[]): void {
  if (order[level] < order[current()]) return
  process.stderr.write(`[heluo:${level}] ${message}${args.length ? ' ' + args.map(String).join(' ') : ''}\n`)
}

export const logger = {
  debug: (m: string, ...a: unknown[]) => log('debug', m, ...a),
  info: (m: string, ...a: unknown[]) => log('info', m, ...a),
  warn: (m: string, ...a: unknown[]) => log('warn', m, ...a),
  error: (m: string, ...a: unknown[]) => log('error', m, ...a),
}
