import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// 测试隔离：HELUO_CODE_HOME 固定指向仓库根 test-tmp/home（不写真实 ~/.heluo-code），
// 各 vitest worker 进程独立执行本 setup（同路径幂等 mkdir，会话文件按 uuid 隔离）。
const home = join(import.meta.dirname, 'test-tmp', 'home')
mkdirSync(home, { recursive: true })
process.env.HELUO_CODE_HOME = home