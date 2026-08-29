import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { boot } from '@heluo-code/core'
import { attachBridge } from './bridge'
import { setupE2EMock } from './e2e-mock'

const isE2E = process.env.HELUO_CODE_E2E_MOCK === '1'

function loadCwd(): string {
  if (process.env.HELUO_CODE_E2E_CWD) return process.env.HELUO_CODE_E2E_CWD
  try {
    const saved = readFileSync(join(app.getPath('userData'), 'cwd.txt'), 'utf8').trim()
    if (saved) return saved
  } catch {
    /* 无持久化记录，走对话框 */
  }
  return ''
}

async function pickCwd(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: '选择工作目录',
    properties: ['openDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const cwd = result.filePaths[0]!
  writeFileSync(join(app.getPath('userData'), 'cwd.txt'), cwd)
  return cwd
}

async function main(): Promise<void> {
  await app.whenReady()
  console.log('[main] boot start, isE2E=', isE2E, 'script=', process.env.HELUO_CODE_E2E_SCRIPT)

  let cwd = loadCwd()
  if (!cwd && !isE2E) {
    // 用户取消选目录则退出（无工作目录无法执行工具，HOME fallback 反直觉）
    const picked = await pickCwd()
    if (!picked) {
      app.quit()
      return
    }
    cwd = picked
  }

  const app_ = await boot(
    { cwd },
    isE2E
      ? {
          model: `mock/${process.env.HELUO_CODE_E2E_SCRIPT ?? 'loop'}`,
          providers: { mock: { type: 'mock' } },
          permission: { mode: 'agent' },
        }
      : undefined,
  )
  if (isE2E) await setupE2EMock(app_.ctx, process.env.HELUO_CODE_E2E_SCRIPT ?? 'loop')

  const win = new BrowserWindow({
    width: 1024,
    height: 720,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      // ESM preload 需要 sandbox: false；安全基线保持 contextIsolation + preload 白名单（R5）
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const bridge = attachBridge({
    ctx: app_.ctx,
    ipcMain,
    webContents: win.webContents,
    cwd,
    pickDirectory: pickCwd,
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  app.on('window-all-closed', () => {
    bridge.dispose()
    void app_.shutdown().finally(() => app.quit())
  })
}

void main().catch((error) => {
  console.error(error)
  app.exit(1)
})