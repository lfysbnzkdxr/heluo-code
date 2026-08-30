import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // @heluo-code/core 的 exports 指向 TS 源码（./src/*.ts），无法被 Electron 直接加载，
    // 故排除 externalize，由构建期 bundle 进 main 产物（core 包零改动，见 README 已知取舍）。
    plugins: [
      externalizeDepsPlugin({ exclude: ['@heluo-code/core'] }),
      {
        name: 'heluo-copy-sandbox-runner',
        closeBundle() {
          // 沙箱 runner 为独立 node 脚本（不随 TS bundle），复制到 out/sandbox/
          // （core 的 RUNNER_PATH 从 out/main 解析 ../../../sandbox/runner.mjs）
          const targetDir = join(dirname(resolve('out/main')), 'sandbox')
          mkdirSync(targetDir, { recursive: true })
          copyFileSync(resolve('../core/sandbox/runner.mjs'), join(targetDir, 'runner.mjs'))
        },
      },
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [
      react(),
      {
        name: 'heluo-dev-csp',
        apply: 'serve',
        transformIndexHtml(html) {
          // dev 需要 inline script（@vitejs/plugin-react 的 HMR preamble），
          // 放宽 script-src；生产构建不含此插件，保持严格 CSP
          return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        },
      },
    ],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
  },
})