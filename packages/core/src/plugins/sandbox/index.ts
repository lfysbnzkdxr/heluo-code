import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Context } from '@cordisjs/core'
import { logger } from '../../shared/logger'

export type SandboxMode = 'off' | 'job' | 'restricted-write' | 'isolated'

export interface SandboxSpawnOptions {
  /** 工作区根（受限进程唯一写根，经 --workspace 传入） */
  cwd: string
  /** 附加写根（--writable-root） */
  writableRoots?: string[]
}

export interface SandboxService {
  /** 实际生效模式（含降级/平台限制） */
  readonly mode: SandboxMode
  spawn(argv: string[], opts: SandboxSpawnOptions): ReturnType<typeof spawn>
}

// runner 定位：core 包内静态资源（不随 TS bundle；desktop 打包时需一并收集）
// plugins/sandbox/index.ts → ../../../ = packages/core → sandbox/runner.mjs
const RUNNER_PATH = fileURLToPath(new URL('../../../sandbox/runner.mjs', import.meta.url))

function effectiveMode(configured: SandboxMode): { mode: SandboxMode; warned: string | null } {
  if (process.platform !== 'win32') {
    return { mode: 'off', warned: 'sandbox 仅支持 Windows；mode 已强制 off（工具层软约束兜底）' }
  }
  if (configured === 'isolated') {
    // P6-0b 前 isolated 尚无防火墙网络隔离，映射为 restricted-write（写限制完整生效）
    return { mode: 'restricted-write', warned: 'sandbox.mode=isolated 的网络隔离待 P6-0b（需管理员 setup），当前按 restricted-write 执行（写限制生效）' }
  }
  return { mode: configured, warned: null }
}

export function sandboxPlugin(ctx: Context): void {
  const configured = (ctx.config?.get() as { sandbox?: { mode?: SandboxMode; writableRoots?: string[] } } | undefined)?.sandbox
  const { mode, warned } = effectiveMode(configured?.mode ?? 'restricted-write')
  if (warned) logger.warn(warned)

  const service: SandboxService = {
    mode,
    spawn(argv, opts) {
      if (mode === 'off') {
        return spawn(argv[0]!, argv.slice(1), {
          cwd: opts.cwd,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      }
      const runnerMode = mode === 'job' ? 'job' : 'restricted'
      const runnerArgs = ['--mode', runnerMode, '--workspace', opts.cwd]
      for (const root of opts.writableRoots ?? []) {
        runnerArgs.push('--writable-root', root)
      }
      runnerArgs.push('--', ...argv)
      return spawn(process.execPath, [RUNNER_PATH, ...runnerArgs], {
        cwd: opts.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Electron 打包环境下 process.execPath 是 electron.exe，需以 node 模式运行 runner
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
    },
  }
  ctx.root.provide('sandbox', service)
}

void Object.assign(sandboxPlugin, { inject: ['config'] })