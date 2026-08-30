import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // projects 模式下根配置不继承，每包显式声明（隔离 HELUO_CODE_HOME 到仓库根 test-tmp/home）
    setupFiles: ['../../test-setup.ts'],
  },
})
