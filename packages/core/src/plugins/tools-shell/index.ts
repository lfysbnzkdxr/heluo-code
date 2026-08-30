import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@cordisjs/core'
import { withinCwd } from '../../shared/path'
import { truncateLines } from '../../shared/output'
import type { Config } from '../../plugins/config/schema'
import type { ToolContext, ToolDefinition, ToolOutcome } from '../../services/tools/types'

// PowerShell 5.1 经管道输出受 console 代码页影响（中文乱码），前缀强制 UTF-8 输出
const UTF8_PREFIX = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
// runner fail-closed 签名：任何沙箱初始化失败 stderr 打印此前缀并 exit 127
const SANDBOX_RUN_FAILURE = 'sandbox-run:'

function getConfig(ctx: Context): Config {
  return ctx.config?.get() as Config
}

// Windows 下强杀进程树（含孙进程），不留僵尸
function killTree(pid: number): void {
  try {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.unref()
  } catch {
    /* ignore */
  }
}

function runCommandTool(ctx: Context): ToolDefinition {
  return {
    name: 'run_command',
    description: '执行 shell 命令（Windows 下经 PowerShell）。stdout/stderr 实时输出；超时/中断会终止进程树；stdin 关闭（交互式命令需在参数中预设）。',
    permission: 'ask',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '完整 shell 命令行' },
        timeout_ms: { type: 'number', description: '超时毫秒数，默认 60000，上限受配置 tools.runCommandMaxTimeoutMs 约束' },
        cwd: { type: 'string', description: '执行目录，默认会话 cwd；须在会话 cwd 子树内' },
      },
      required: ['command'],
    },
    async execute(args: unknown, tctx: ToolContext): Promise<ToolOutcome> {
      const { command, timeout_ms, cwd } = (args ?? {}) as { command?: unknown; timeout_ms?: unknown; cwd?: unknown }
      if (typeof command !== 'string' || command.length === 0) {
        return { ok: false, errorForModel: 'run_command: 缺少 command 参数' }
      }
      if (tctx.signal.aborted) return { ok: false, errorForModel: 'run_command: 操作已取消' }
      const cfg = getConfig(ctx)
      const maxTimeout = cfg.tools.runCommandMaxTimeoutMs
      const timeout = typeof timeout_ms === 'number' && timeout_ms > 0 ? timeout_ms : 60000
      if (timeout > maxTimeout) {
        return { ok: false, errorForModel: `run_command: timeout_ms ${timeout} 超过配置上限 ${maxTimeout}ms` }
      }
      const cmdCwd = typeof cwd === 'string' && cwd.length > 0 ? cwd : tctx.cwd
      const absCwd = isAbsolute(cmdCwd) ? cmdCwd : resolve(tctx.cwd, cmdCwd)
      if (!withinCwd(tctx.cwd, absCwd)) {
        return { ok: false, errorForModel: `run_command: 拒绝在 cwd 之外目录执行：${cwd}` }
      }

      let exitCode: number | null = null
      let timedOut = false
      let spawnError: string | null = null
      let output = ''

      // 进程创建统一走 ctx.sandbox（P6-0a）：restricted-write 经 runner 以 WRITE_RESTRICTED 受限令牌
      // 执行（写 cwd 外被 OS 拒绝，KILL_ON_JOB_CLOSE 进程树必杀）；job 模式无特权保底；off 透传。
      const child = ctx.root.sandbox!.spawn(
        ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', UTF8_PREFIX + command],
        { cwd: absCwd, writableRoots: cfg.sandbox?.writableRoots ?? [] },
      )

      const onData = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        output += text
        if (!tctx.signal.aborted) {
          tctx.session.append('tool/stream', { callId: tctx.callId, delta: text })
        }
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)

      // kill 后兜底：若 close 迟迟不触发（taskkill 失败等异常），1.5s 后强制结束等待，杜绝永久挂起
      let killFallback: NodeJS.Timeout | null = null
      let settled = false
      let settleWait!: () => void
      const finishWait = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (killFallback) clearTimeout(killFallback)
        tctx.signal.removeEventListener('abort', onAbort)
        settleWait()
      }
      const scheduleKillFallback = (): void => {
        if (killFallback) return
        killFallback = setTimeout(() => {
          killFallback = null
          finishWait()
        }, 1500)
        killFallback.unref?.()
      }

      const timer = setTimeout(() => {
        timedOut = true
        killTree(child.pid ?? 0)
        scheduleKillFallback()
      }, timeout)

      const onAbort = (): void => {
        killTree(child.pid ?? 0)
        scheduleKillFallback()
      }
      tctx.signal.addEventListener('abort', onAbort, { once: true })

      await new Promise<void>((resolvePromise) => {
        settleWait = resolvePromise
        child.on('error', (err) => {
          spawnError = err.message
          finishWait()
        })
        child.on('close', (code) => {
          exitCode = code
          finishWait()
        })
      })

      const truncated = truncateLines(output.split('\n'), cfg.tools.outputTruncateHead, cfg.tools.outputTruncateTail).join('\n')

      if (tctx.signal.aborted) {
        return { ok: false, errorForModel: `run_command: 操作已取消（进程树已终止）\n$ ${command}\n${truncated}` }
      }
      if (timedOut) {
        return {
          ok: false,
          errorForModel: `run_command: 命令超时（${timeout}ms），进程树已终止\n$ ${command}\n${truncated}`,
        }
      }
      if (spawnError) {
        return { ok: false, errorForModel: `run_command: 无法启动 PowerShell：${spawnError}` }
      }
      if (exitCode === 127 && output.includes(SANDBOX_RUN_FAILURE)) {
        // fail-closed：沙箱初始化失败（令牌/ACL/进程创建），拒绝静默无沙箱执行
        const detail = output.split('\n').find((l) => l.includes(SANDBOX_RUN_FAILURE)) ?? output.trim()
        return { ok: false, errorForModel: `run_command: 沙箱初始化失败，命令未执行（fail-closed）：${detail}\n提示：可配置 sandbox.mode='job'（Job Object 保底）或 'off'` }
      }
      if (exitCode !== 0) {
        return {
          ok: false,
          errorForModel: `run_command: 命令以退出码 ${exitCode} 结束\n$ ${command}\n${truncated}`,
        }
      }
      return { ok: true, outputForModel: `$ ${command}\n${truncated}\n[exit code: 0]` }
    },
  }
}

export function toolsShellPlugin(ctx: Context): void {
  ctx.root.tools!.register(runCommandTool(ctx))
}

void Object.assign(toolsShellPlugin, { inject: ['tools', 'sandbox'] })
