# heluo-code

从零实现的 AI 编程助手 harness（无头核心 + 薄客户端）。架构 / 决策 / 领域模型 / 分阶段计划见 [`docs/SPEC.md`](docs/SPEC.md)（主契约），接口 / 工具 / 权限 / 配置等密度高详规见 [`docs/specs/`](docs/specs)。

## 环境要求

- Node.js ≥ 20.19（已验证 24.x 可用）
- pnpm（安装其一即可）：`corepack enable`，或 `npm i -g pnpm`

## 快速开始

```bash
pnpm install        # 安装依赖（首次会运行 esbuild 的 postinstall）
pnpm dev            # 启动 CLI REPL（bin: heluo-code；P2：agent loop + 6 工具 + 权限确认 + 优雅退出；P3：config.plugins 外部插件加载）
pnpm test           # 运行 vitest 单元测试
pnpm typecheck      # tsc 严格类型检查（core + cli + plugin-web-fetch）
```

## 当前进度

- **P3 已实施**（2026-08-29）：插件生态化——外部插件加载（`config.plugins` 支持 npm 包名/本地路径，全局配置限定，失败不中断启动）；示范插件 `@heluo-code/plugin-web-fetch`（`web_fetch` 工具，seam 三角色：契约=core 导出类型、实现=插件包、消费=agentLoop）；provider 注册制佐证（新增 provider 零核心改动）；外部插件与内置权限插件 pre-execute 链共存；插件卸载（dispose）无残留（工具注销、瀑布钩子与事件监听全部反注册，自动化断言）；89 条测试全绿（新增 12 条）。
- **P2 已实施**（2026-08-29）：工具集全量（6/6）——edit_file / list_dir / grep_search / run_command 补齐，Windows shell 实测定稿（Q2 关闭）；权限全量——run_command 命令首 token 前缀 always 记忆、Quest 可配 `questRunCommand`、`tools.exclude`/`grepMaxResults`/`runCommandMaxTimeoutMs`/`editRequiresRead` 配置生效；优雅退出（interrupt → 5s 等待 → 进程树强杀 → 日志闭合）；`tool/stream` 实时输出事件、`post-execute` 钩子；77 条测试全绿（含闭环场景自动断言）。
- **真测冒烟已通过**（2026-08-29）：CLI 端到端跑通「写脚本→运行报错→修复→再运行」闭环（DeepSeek V4 Flash，11,009 tokens），并修复真测暴露的 5 处缺陷（AI SDK v7 instructions 适配、permissions 同步响应竞态、CLI EOF 退出/退订时机/prompt 崩溃）与评审整改 3 项（gitignore 目录栈、taskkill 兜底、API/文档/测试卫生），详见 docs/SPEC.md §11 P2。
- 待办：P4 Electron 桌面壳（P4a 最小可用 GUI / P4b 增强体验）。

## 仓库结构（当前阶段）

```
packages/
  core/    @heluo-code/core  —— 无头核心：Cordis 插件内核 + session/llm/tools/agentLoop 服务
                               + config/permissions/system-prompt/tools-fs/tools-shell/llm-openai-compatible/llm-mock/plugin-loader 插件
  cli/     @heluo-code/cli   —— 开发调试 REPL（P2：6 工具全量、权限确认、优雅退出）
  plugin-web-fetch/
           @heluo-code/plugin-web-fetch —— P3 示范外部插件：web_fetch 工具（npm 包名/本地路径经 config.plugins 加载）
```

`packages/desktop`（Electron 桌面壳）按规划推迟至 **P4** 实施，当前不建。

## 配置与运行说明

- 全局配置：`~/.heluo-code/config.jsonc`
- 项目级配置：`<cwd>/.heluo-code/config.jsonc`（优先级：项目 > 全局 > 内置默认；CLI 参数可覆盖）
- 支持 JSONC（注释 / 尾逗号）与 `{env:VAR}` 占位替换；字段与合并语义见 [`docs/specs/config.md`](docs/specs/config.md)
- `providers` / `plugins` 安全边界、AGENTS.md 自动发现已在 **P1** 生效
- 本地开发避开 C 盘：用环境变量 `HELUO_CODE_HOME` 覆盖全局配置目录（如指向项目内 `.heluo-code/`），详见 [`docs/specs/config.md`](docs/specs/config.md)
- 临时开发文件放仓库内 `tmp/`（已 gitignore）

## 已知工程取舍（dev-only）

- **`pnpm-workspace.yaml` 的 `dangerouslyAllowAllBuilds: true`**：当前 pnpm v11 的 `allowBuilds` 无法批准传递依赖（esbuild 经 vitest/tsx 引入）的构建脚本，故放开以允许 esbuild 的 postinstall。依赖均经锁定且可信，非生产发布项；待 pnpm 修复 `allowBuilds` 对传递依赖的匹配后，可收敛为 `allowBuilds: ['esbuild']`。
- **TypeScript `moduleResolution: Bundler`**：P0 经 tsx / vitest 运行、不 emit 产物；若未来需 tsc 真正产出 `dist/`（如 P4 桌面打包），再评估切回 NodeNext 并补 `.js` 扩展名。**发布前提**：workspace 包 exports 均指向 `./src/*.ts`，真实 npm 发布前需构建产物并更新 exports（P6 打包项）。
- **`@heluo-code/core` devDep ↔ `@heluo-code/plugin-web-fetch` dep 循环**：P3 验收要求「npm 包名加载」需 core 测试侧能解析该包，故 core 以 devDependencies 引入（插件依赖 core 为正常方向）。pnpm 以 junction 链接处理（`git status --ignored` 可能刷 "Filename too long"，node_modules 已被 gitignore，不影响提交）；运行时无循环（插件对 core 仅 type-only import，编译后被擦除）。发布后用户侧安装插件则无此循环。

## 参考

- [`docs/SPEC.md`](docs/SPEC.md) — 主契约（架构 / 决策 / 领域模型 / 分阶段计划）
- [`docs/specs/interfaces.md`](docs/specs/interfaces.md) — 接口类型（Tool / LLM seam / Agent / Op / EventMsg）
- [`docs/specs/tools.md`](docs/specs/tools.md) — 内置工具集
- [`docs/specs/permissions.md`](docs/specs/permissions.md) — 权限系统
- [`docs/specs/config.md`](docs/specs/config.md) — 配置系统
