import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      '!packages/desktop',
      // desktop 以配置文件引用：限制测试范围为 src/**/*.test.ts，
      // 避免 e2e/（Playwright spec）被 vitest 默认 include 捡起
      'packages/desktop/vitest.config.ts',
    ],
  },
})