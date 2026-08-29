import { _electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launch(cwd: string, script: string): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await _electron.launch({
    args: [join(import.meta.dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      HELUO_CODE_E2E_MOCK: '1',
      HELUO_CODE_E2E_SCRIPT: script,
      HELUO_CODE_E2E_CWD: cwd,
    },
  })
  return { app, window: await app.firstWindow() }
}

async function sendTask(window: Page, text: string): Promise<void> {
  await window.getByTestId('composer-input').fill(text)
  await window.getByTestId('send-button').click()
}

async function approveNextCard(window: Page, button: 'allow' | 'always' | 'deny'): Promise<void> {
  await window.getByTestId('permission-card').waitFor({ timeout: 30_000 })
  await window.getByTestId(`permission-${button}`).click()
}

test('闭环：GUI 完成写脚本→运行→读报错→修复→再运行（含 4 次权限卡片 allow）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'heluo-e2e-loop-'))
  const { app, window } = await launch(cwd, 'loop')
  try {
    await sendTask(window, '写一个脚本并跑通')

    // 权限链 4 次确认：write_file / run_command / edit_file / run_command
    for (let i = 0; i < 4; i++) {
      await approveNextCard(window, 'allow')
    }

    await expect(window.getByTestId('last-turn-end')).toContainText('completed', { timeout: 30_000 })

    const names = await window.locator('.tool-card-name').allTextContents()
    expect(names).toEqual(['write_file', 'run_command', 'read_file', 'edit_file', 'run_command'])

    // 修复结果落盘
    expect(readFileSync(join(cwd, 'script.js'), 'utf8')).toBe('const undefinedVar = 42\nconsole.log(undefinedVar)')
  } finally {
    await app.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('权限三态：always 记忆（同工具不弹卡）、allow 不记忆、deny 拒绝', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'heluo-e2e-perm-'))
  const { app, window } = await launch(cwd, 'perm')
  try {
    await sendTask(window, '写两个文件并跑命令')

    // 卡片序列：write_file(always) → run_command(allow) → run_command(deny)
    await approveNextCard(window, 'always')
    await approveNextCard(window, 'allow')
    await approveNextCard(window, 'deny')

    await expect(window.getByTestId('last-turn-end')).toContainText('completed', { timeout: 30_000 })

    // write_file 只问一次（always 后第二次写文件不弹卡），run_command 问两次（allow 不记忆）→ 共 3 张卡
    const cards = window.getByTestId('tool-card')
    expect(await cards.count()).toBe(4)
    // 第 3 张（deny 的 run_command）为失败态
    await expect(cards.nth(3)).toContainText('失败')

    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('one')
    expect(readFileSync(join(cwd, 'b.txt'), 'utf8')).toBe('two')
  } finally {
    await app.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('中断①：权限等待中点停止 → turn interrupted、卡片消失、可再输入', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'heluo-e2e-interrupt-waiting-'))
  const { app, window } = await launch(cwd, 'interrupt-waiting')
  try {
    await sendTask(window, '运行一个命令')
    await window.getByTestId('permission-card').waitFor({ timeout: 30_000 })

    await window.getByTestId('stop-button').click()
    await expect(window.getByTestId('last-turn-end')).toContainText('interrupted', { timeout: 30_000 })
    await expect(window.getByTestId('permission-card')).toHaveCount(0)

    // 可再输入：输入框恢复可用并再次提交，新 turn 正常完成
    await expect(window.getByTestId('composer-input')).toBeEnabled()
    await sendTask(window, '再来一次')
    await expect(window.getByTestId('last-turn-end')).toContainText('completed', { timeout: 30_000 })
  } finally {
    await app.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

// 进程树杀灭由 core 层单测兜底（tools-shell index.test.ts「中断终止进程树且不挂起」），
// 此处只断言 turn 收尾与卡片清理
test('中断②：工具执行中点停止 → run_command 收尾、turn interrupted', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'heluo-e2e-interrupt-running-'))
  const { app, window } = await launch(cwd, 'interrupt-running')
  try {
    await sendTask(window, '跑一个长命令')
    await approveNextCard(window, 'allow')

    await window.locator('.tool-card-status-running').waitFor({ timeout: 30_000 })
    await window.getByTestId('stop-button').click()

    await expect(window.getByTestId('last-turn-end')).toContainText('interrupted', { timeout: 30_000 })
    await expect(window.locator('.tool-card-status-running')).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('diff 视图：write_file 新建全 add、edit_file 有 del/add', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'heluo-e2e-diff-'))
  const { app, window } = await launch(cwd, 'diff')
  try {
    await sendTask(window, '新建并修改文件')
    await approveNextCard(window, 'allow')
    await approveNextCard(window, 'allow')
    await expect(window.getByTestId('last-turn-end')).toContainText('completed', { timeout: 30_000 })

    const cards = window.getByTestId('tool-card')
    expect(await cards.count()).toBe(3)

    // write_file 卡片：diff 全 add（新建）
    const writeDiff = cards.nth(0).getByTestId('diff-view')
    await expect(writeDiff).toBeVisible()
    await expect(writeDiff.locator('.diff-add')).toHaveCount(2)
    await expect(writeDiff.locator('.diff-del')).toHaveCount(0)

    // edit_file 卡片：diff 有 del + add
    const editDiff = cards.nth(2).getByTestId('diff-view')
    await expect(editDiff.locator('.diff-del')).toHaveCount(1)
    await expect(editDiff.locator('.diff-add')).toHaveCount(1)
    await expect(editDiff.locator('.diff-del')).toContainText('line2')
    await expect(editDiff.locator('.diff-add')).toContainText('line2-modified')
  } finally {
    await app.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('模式切换即时生效：agent→quest 后写操作不再弹卡（specs/permissions.md §8.3）', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'heluo-e2e-mode-'))
  const { app, window } = await launch(cwd, 'mode')
  try {
    await sendTask(window, '写两个文件')
    // agent 模式：第一张 write_file 卡弹出（等待授权中）
    await window.getByTestId('permission-card').waitFor({ timeout: 30_000 })

    // 等待授权中切到 Quest：已弹出的卡不受追溯，后续判定即时用新模式
    await window.getByTestId('mode-quest').click()
    await approveNextCard(window, 'allow')

    // 第二个 write_file 不再弹卡（quest 对 ask 工具自动放行），turn 正常完成、无残留卡
    await expect(window.getByTestId('last-turn-end')).toContainText('completed', { timeout: 30_000 })
    expect(await window.getByTestId('permission-card').count()).toBe(0)
    expect(await window.getByTestId('tool-card').count()).toBe(2)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('one')
    expect(readFileSync(join(cwd, 'b.txt'), 'utf8')).toBe('two')
  } finally {
    await app.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('多会话：新建/切换保留历史，切换不串事件', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'heluo-e2e-sessions-'))
  const { app, window } = await launch(cwd, 'simple')
  try {
    // 会话 A：一次 turn
    await sendTask(window, '写文件')
    await approveNextCard(window, 'allow')
    await expect(window.getByTestId('last-turn-end')).toContainText('completed', { timeout: 30_000 })
    const messagesA = await window.getByTestId('message-assistant').count()
    expect(messagesA).toBeGreaterThan(0)

    // 新建会话 B：主区清空（无消息、无工具卡）
    await window.getByTestId('session-create').click()
    await expect(window.getByTestId('session-item')).toHaveCount(2)
    await expect(window.getByTestId('message-assistant')).toHaveCount(0)
    await expect(window.getByTestId('tool-card')).toHaveCount(0)

    // 会话 B：一次 turn（事件不串入 A 的历史）
    await sendTask(window, '再写一个文件')
    await approveNextCard(window, 'allow')
    await expect(window.getByTestId('last-turn-end')).toContainText('completed', { timeout: 30_000 })

    // 切回会话 A：历史完整恢复，且不含 B 的消息
    await window.getByTestId('session-item').first().click()
    await expect(window.getByTestId('message-assistant')).toHaveCount(messagesA)
    await expect(window.getByTestId('tool-card')).toHaveCount(1)

    // 再切回 B：B 的历史恢复
    await window.getByTestId('session-item').nth(1).click()
    await expect(window.getByTestId('tool-card')).toHaveCount(1)
    await expect(window.getByTestId('last-turn-end')).toContainText('completed')
  } finally {
    await app.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})