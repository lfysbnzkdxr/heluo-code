# heluo-code

从零实现的 AI 编程助手 harness（无头核心 + 薄客户端）。架构 / 决策 / 领域模型 / 分阶段计划见 [`docs/SPEC.md`](docs/SPEC.md)（主契约），接口 / 工具 / 权限 / 配置等密度高详规见 [`docs/specs/`](docs/specs)。

## 环境要求

- Node.js ≥ 20.19（已验证 24.x 可用）
- pnpm（安装其一即可）：`corepack enable`，或 `npm i -g pnpm`

## 快速开始

```bash
pnpm install        # 安装依赖（首次会运行 esbuild 的 postinstall）
pnpm dev            # 启动 CLI REPL（bin: heluo-code；P2：agent loop + 6 工具 + 权限确认 + 优雅退出）
pnpm test           # 运行 vitest 单元测试
pnpm typecheck      # tsc 严格类型检查（core + cli）
```

## 当前进度

- **P2 已实施**（2026-08-29）：工具集全量（6/6）——edit_file / list_dir / grep_search / run_command 补齐，Windows shell 实测定稿（Q2 关闭）；权限全量——run_command 命令首 token 前缀 always 记忆、Quest 可配 `questRunCommand`、`tools.exclude`/`grepMaxResults`/`runCommandMaxTimeoutMs`/`editRequiresRead` 配置生效；优雅退出（interrupt → 5s 等待 → 进程树强杀 → 日志闭合）；`tool/stream` 实时输出事件、`post-execute` 钩子；77 条测试全绿（含闭环场景自动断言）。
- **真测冒烟已通过**（2026-08-29）：CLI 端到端跑通「写脚本→运行报错→修复→再运行」闭环（DeepSeek V4 Flash，11,009 tokens），并修复真测暴露的 5 处缺陷（AI SDK v7 instructions 适配、permissions 同步响应竞态、CLI EOF 退出/退订时机/prompt 崩溃）与评审整改 3 项（gitignore 目录栈、taskkill 兜底、API/文档/测试卫生），详见 docs/SPEC.md §11 P2。
- 待办：P3 插件生态化。

## 仓库结构（当前阶段）

```
packages/
  core/    @heluo-code/core  —— 无头核心：Cordis 插件内核 + session/llm/tools/agentLoop 服务
                               + config/permissions/system-prompt/tools-fs/tools-shell/llm-openai-compatible/llm-mock 插件
  cli/     @heluo-code/cli   —— 开发调试 REPL（P2：6 工具全量、权限确认、优雅退出）
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
- **TypeScript `moduleResolution: Bundler`**：P0 经 tsx / vitest 运行、不 emit 产物；若未来需 tsc 真正产出 `dist/`（如 P4 桌面打包），再评估切回 NodeNext 并补 `.js` 扩展名。

## 参考

- [`docs/SPEC.md`](docs/SPEC.md) — 主契约（架构 / 决策 / 领域模型 / 分阶段计划）
- [`docs/specs/interfaces.md`](docs/specs/interfaces.md) — 接口类型（Tool / LLM seam / Agent / Op / EventMsg）
- [`docs/specs/tools.md`](docs/specs/tools.md) — 内置工具集
- [`docs/specs/permissions.md`](docs/specs/permissions.md) — 权限系统
- [`docs/specs/config.md`](docs/specs/config.md) — 配置系统
