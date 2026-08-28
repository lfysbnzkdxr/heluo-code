import { isAbsolute, relative, sep } from 'node:path'

export function withinCwd(cwd: string, abs: string): boolean {
  const rel = relative(cwd, abs)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}
