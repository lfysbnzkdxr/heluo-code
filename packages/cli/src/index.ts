import { createInterface } from 'node:readline'
import { boot } from '@heluo-code/core'

async function main(): Promise<void> {
  const app = await boot({ cwd: process.cwd() })
  const model = app.ctx.config?.get().model || '(unset)'

  console.log('heluo-code REPL (P0 scaffold)')
  console.log(`model=${model}  |  empty line submits, Ctrl+C exits`)
  console.log('────────────────────────────────────────')

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let buffer = ''

  rl.setPrompt('> ')
  rl.prompt()

  rl.on('line', (line) => {
    if (line.trim() === '') {
      if (buffer.trim() !== '') {
        console.log(`[echo] ${buffer.trim()}`)
        buffer = ''
      }
    } else {
      buffer += (buffer ? '\n' : '') + line
    }
    rl.prompt()
  })

  rl.on('SIGINT', () => {
    console.log('\nbye')
    rl.close()
  })

  await new Promise<void>((resolve) => rl.on('close', resolve))
  await app.shutdown()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
