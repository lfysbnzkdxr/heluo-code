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
  let pendingPermission: { id: string } | null = null
  let activeController: AbortController | null = null

  ctx.permissions!.onRequest((req) => {
    pendingPermission = { id: req.id }
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
    try {
      await ctx.agentLoop!.openTurn({ session, text, signal: controller.signal })
    } catch (error) {
      process.stdout.write(`\n! 错误: ${error instanceof Error ? error.message : String(error)}\n`)
    } finally {
      turnActive = false
      activeController = null
      rl.setPrompt('> ')
      rl.prompt()
    }
  }

  console.log('heluo-code REPL (P1)')
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
    if (pendingPermission) {
      const v = line.trim().toLowerCase()
      const decision = v === 'y' || v === 'yes' ? 'allow' : v === 'a' || v === 'always' ? 'always' : 'deny'
      const id = pendingPermission.id
      pendingPermission = null
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
      pendingPermission = null
      activeController.abort()
      process.stdout.write('\n（中断当前任务）\n')
    } else {
      process.stdout.write('\nbye\n')
      rl.close()
    }
  })

  await new Promise<void>((resolve) => rl.on('close', resolve))
  unsubscribe()
  await app.shutdown()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
