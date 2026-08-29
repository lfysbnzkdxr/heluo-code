import type { Context } from '@heluo-code/core'
import { llmMockPlugin, registerMockStepScript } from '@heluo-code/core'

type MockChunk =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; call: { id: string; name: string; argsJson: string } }
  | { type: 'done' }

// e2e 脚本（mock provider 只 mock LLM，工具真实执行）。复用 P2 场景测试的闭环结构
// （packages/core/src/__tests__/p2-scenario.test.ts）。
export const E2E_SCRIPTS: Record<string, MockChunk[][]> = {
  // 闭环：写脚本→运行报错→读文件→修复→再运行通过（权限 mode=agent 下弹卡 4 次：
  // write_file / run_command / edit_file / run_command）
  loop: [
    [
      { type: 'text-delta', delta: '先写一个脚本' },
      {
        type: 'tool-call',
        call: { id: 's1', name: 'write_file', argsJson: JSON.stringify({ path: 'script.js', content: 'console.log(undefinedVar)' }) },
      },
      { type: 'done' },
    ],
    [
      { type: 'text-delta', delta: '运行看看' },
      { type: 'tool-call', call: { id: 's2', name: 'run_command', argsJson: JSON.stringify({ command: 'node script.js' }) } },
      { type: 'done' },
    ],
    [
      { type: 'text-delta', delta: '读一下脚本定位错误' },
      { type: 'tool-call', call: { id: 's3', name: 'read_file', argsJson: JSON.stringify({ path: 'script.js' }) } },
      { type: 'done' },
    ],
    [
      { type: 'text-delta', delta: '修复脚本' },
      {
        type: 'tool-call',
        call: {
          id: 's4',
          name: 'edit_file',
          argsJson: JSON.stringify({
            path: 'script.js',
            old_string: 'console.log(undefinedVar)',
            new_string: 'const undefinedVar = 42\nconsole.log(undefinedVar)',
          }),
        },
      },
      { type: 'done' },
    ],
    [
      { type: 'text-delta', delta: '再运行确认' },
      { type: 'tool-call', call: { id: 's5', name: 'run_command', argsJson: JSON.stringify({ command: 'node script.js' }) } },
      { type: 'done' },
    ],
    [{ type: 'text-delta', delta: '修复完成，脚本输出 42' }, { type: 'done' }],
  ],
  // 权限三态：write_file always（后同工具不再弹卡）、run_command allow（不记忆）、run_command deny
  perm: [
    [
      { type: 'text-delta', delta: '写第一个文件' },
      { type: 'tool-call', call: { id: 'p1', name: 'write_file', argsJson: JSON.stringify({ path: 'a.txt', content: 'one' }) } },
      { type: 'done' },
    ],
    [
      { type: 'text-delta', delta: '写第二个文件' },
      { type: 'tool-call', call: { id: 'p2', name: 'write_file', argsJson: JSON.stringify({ path: 'b.txt', content: 'two' }) } },
      { type: 'done' },
    ],
    [
      { type: 'text-delta', delta: '运行命令（allow 不记忆）' },
      { type: 'tool-call', call: { id: 'p3', name: 'run_command', argsJson: JSON.stringify({ command: 'Write-Output ok' }) } },
      { type: 'done' },
    ],
    [
      { type: 'text-delta', delta: '再次运行同前缀命令（仍询问，上次是 allow 非 always）' },
      { type: 'tool-call', call: { id: 'p4', name: 'run_command', argsJson: JSON.stringify({ command: 'Write-Output nope' }) } },
      { type: 'done' },
    ],
    [{ type: 'text-delta', delta: '结束' }, { type: 'done' }],
  ],
  // 中断①：权限等待中停止（abort 自动 deny 兜底 → turn interrupted）
  'interrupt-waiting': [
    [
      { type: 'text-delta', delta: '运行一个命令' },
      { type: 'tool-call', call: { id: 'i1', name: 'run_command', argsJson: JSON.stringify({ command: 'Write-Output blocked' }) } },
      { type: 'done' },
    ],
    [{ type: 'text-delta', delta: '不应到达' }, { type: 'done' }],
  ],
  // 中断②：工具执行中点停止（run_command 8s 长命令，abort 杀进程树）
  'interrupt-running': [
    [
      { type: 'text-delta', delta: '跑一个长命令' },
      {
        type: 'tool-call',
        call: { id: 'i2', name: 'run_command', argsJson: JSON.stringify({ command: 'node -e "setTimeout(()=>{}, 8000)"' }) },
      },
      { type: 'done' },
    ],
    [{ type: 'text-delta', delta: '不应到达' }, { type: 'done' }],
  ],
}

// e2e 模式：挂 mock provider 并注册指定脚本（HELUO_CODE_E2E_MOCK=1 时由 main 调用）
export async function setupE2EMock(ctx: Context, script: string): Promise<void> {
  const steps = E2E_SCRIPTS[script]
  if (!steps) throw new Error(`unknown e2e script: ${script}`)
  await ctx.plugin(llmMockPlugin)
  registerMockStepScript(script, steps)
}