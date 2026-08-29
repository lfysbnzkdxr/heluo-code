import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  // Electron 应用全局有状态（单会话），用例串行执行
  workers: 1,
})