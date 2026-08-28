import { createInterface } from 'node:readline'
import { boot } from '@heluo-code/core'
import type { SessionEvent } from '@heluo-code/core'

async function main(): Promise<void> {
  const app = await boot({ cwd: process.cwd() })
  const ctx = app.ctx
  const modelConfig = ctx.config?.get().model
  const model = modelConfig || '(unset)'

  const session = ctx.agentLoop!.createSession(process.cwd())
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  let turnActive = false
  let pendingPermissionId: string | null = null
  let activeController: AbortController | null = null
  let currentTurn: Promise<void> | null = null
  const autoApprove = process.argv.includes('--yes')

  ctx.permissions!.onRequest((req) => {
    if (autoApprove) {
      // 非交互冒烟/CI：权限链照常走一遍（事件/记忆），仅决策自动 allow
      ctx.permissions!.respond(req.id, 'allow')
      process.stdout.write(`\n⚙ 自动放行 ${req.tool}\n`)
      return
    }
    pendingPermissionId = req.id
    process.stdout.write(`\n? 允许工具 ${req.tool} ${req.argsSummary} ? [y/n/a]: `)
  })

  const unsubscribe = session.subscribe((ev: SessionEvent) => {
    switch (ev.type) {
      case 'assistant/chunk':
        process.stdout.write(ev.properties.delta)
        break
      case 'tool/result':
        process.stdout.write(
          `\n⚙ ${ev.properties.callId} ${ev.properties.isError ? '✗' : '✓'} ${ev.properties.output.slice(0, 200)}\n`,
        )
        break
      case 'turn/end':
        process.stdout.write(
          `\n— turn 结束 (${ev.properties.stopReason}${ev.properties.usage ? `, ${ev.properties.usage.totalTokens} tokens` : ''}) —\n`,
        )
        break
      default:
        break
    }
  })

  const submit = async (text: string): Promise<void> => {
    turnActive = true
    const controller = new AbortController()
    activeController = controller
    currentTurn = (async () => {
      try {
        await ctx.agentLoop!.openTurn({ session, text, signal: controller.signal })
      } catch (error) {
        process.stdout.write(`\n! 错误: ${error instanceof Error ? error.message : String(error)}\n`)
      } finally {
        turnActive = false
        activeController = null
        currentTurn = null
        try {
          rl.setPrompt('> ')
          rl.prompt()
        } catch {
          /* readline 已关闭（管道 EOF 退出场景） */
        }
      }
    })()
    await currentTurn
  }

  console.log('heluo-code REPL (P2)')
  console.log(`model=${model}  |  enter 提交（空行），Ctrl+C 中断/退出`)
  console.log('────────────────────────────────────────')
  if (!modelConfig) {
    console.log(
      '提示: 未配置 model，LLM 调用将失败。请编辑全局配置 ~/.heluo-code/config.jsonc 设置 model（本地开发可用 HELUO_CODE_HOME 覆盖目录），参见 docs/specs/config.md',
    )
  }

  rl.setPrompt('> ')
  rl.prompt()

  let buffer = ''
  rl.on('line', (line) => {
    if (pendingPermissionId) {
      const v = line.trim().toLowerCase()
      const decision = v === 'y' || v === 'yes' ? 'allow' : v === 'a' || v === 'always' ? 'always' : 'deny'
      const id = pendingPermissionId
      pendingPermissionId = null
      ctx.permissions!.respond(id, decision)
      return
    }
    if (turnActive) {
      process.stdout.write('会话忙，请等待或按 Ctrl+C 中断\n')
      return
    }
    if (line.trim() === '') {
      if (buffer.trim() !== '') {
        const text = buffer.trim()
        buffer = ''
        void submit(text)
      }
    } else {
      buffer += (buffer ? '\n' : '') + line
    }
  })

  rl.on('SIGINT', () => {
    if (activeController) {
      pendingPermissionId = null
      activeController.abort()
      process.stdout.write('\n（中断当前任务）\n')
    } else {
      process.stdout.write('\nbye\n')
      rl.close()
    }
  })

  // SIGTERM（外部 kill/系统关机）：中断进行中 turn 后完整退出（core shutdown 会收尾日志）
  let sigterm = false
  process.on('SIGTERM', () => {
    if (sigterm) return
    sigterm = true
    process.stdout.write('\n（收到退出信号，正在关闭…）\n')
    if (activeController) {
      pendingPermissionId = null
      activeController.abort()
    }
    rl.close()
  })

  await new Promise<void>((resolve) => rl.on('close', resolve))
  // 输入流关闭（如管道 EOF）时等待进行中的 turn 收尾，避免打断后遗留半开 turn
  const pendingId = pendingPermissionId
  pendingPermissionId = null
  if (pendingId) ctx.permissions!.respond(pendingId, 'deny')
  if (currentTurn) await currentTurn
  unsubscribe()
  await app.shutdown()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
