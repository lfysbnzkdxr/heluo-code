# heluo-code

从零实现的 AI 编程助手 harness（无头核心 + 薄客户端）。架构 / 决策 / 领域模型 / 分阶段计划见 [`docs/SPEC.md`](docs/SPEC.md)（主契约），接口 / 工具 / 权限 / 配置等密度高详规见 [`docs/specs/`](docs/specs)。

> 项目工作区约定（临时文件落盘位置 / 阶段流程 / 验证命令 / 真测惯例）见 [`AGENTS.md`](AGENTS.md)。

## 环境要求

- Node.js ≥ 20.19（已验证 24.x 可用）
- pnpm（安装其一即可）：`corepack enable`，或 `npm i -g pnpm`

## 快速开始

```bash
pnpm install        # 安装依赖（首次会运行 esbuild 的 postinstall）
pnpm dev            # 启动 CLI REPL（bin: heluo-code；P2：agent loop + 6 工具 + 权限确认 + 优雅退出；P3：config.plugins 外部插件加载）
pnpm dev:desktop    # 启动 Electron 桌面应用（P4：聊天流式 + diff + reasoning 折叠 + token 角标 + 权限卡片 + 中断 + cwd + 多会话侧栏 + 模式切换 + 设置页，electron-vite HMR）
pnpm build:desktop  # 构建桌面产物（out/main、out/preload、out/renderer）
pnpm test           # 运行 vitest 单元测试（core + cli + desktop，156 条）
pnpm test:e2e       # 构建 + Playwright Electron e2e（9 用例：闭环 / 权限三态 / 中断①② / diff / 模式切换 / 多会话 / 子代理看板①②，mock provider 不触网）
pnpm typecheck      # tsc 严格类型检查（core + cli + plugin-web-fetch + desktop）
pnpm --filter @heluo-code/desktop package  # electron-builder 打包 Windows 安装包（release/heluo-code-<version>-setup.exe）
```

## 当前进度

- **P6-0 部分实施**（2026-08-30）：**P6-0-pre** JSONL 会话持久化落地（写盘 + resume 加载 + 容错，SPEC §5.2 缺口闭合）；**P6-0a 进程级沙箱写限制**——`restricted-write`（WRITE_RESTRICTED 受限令牌 + workspace/temp 派生 SID + ACE 种/撤 + CreateProcessAsUserW + KILL_ON_JOB_CLOSE，普通用户实测可用）+ `job`（无特权保底进程树必杀）双模式；`ctx.sandbox` seam + runner.mjs（fail-closed 127 + sandbox-run: 前缀）+ `sandbox.mode`/`writableRoots` 配置；安全验收（写 cwd 外 OS 拒绝 / 进程树必杀 / fail-closed）全自动化断言；vitest 156 全绿 + e2e 9 用例全绿 + typecheck 全绿；详设与实测结论见 docs/specs/sandbox.md；网络隔离（P6-0b）进行中
- **P5 已实施**（2026-08-30）：**P5a** 多 agent 编排核心——agents 服务（factory/definition 注册/create/get/list/dispose/onStatusChange，seam 可替换）+ `spawn_subagent` 工具（独立会话 + 工具白名单 + 摘要回传，主会话落 subagent/spawn|finished 编排事件，derive 投影忽略防上下文污染）+ 并发上限默认 4 FIFO 排队（`config.agents.maxConcurrency`）+ 内置 explorer 预定义 agent + Q5 权限继承（子 agent 模式 = spawn 时父会话快照，always 记忆按会话隔离不回流，dispose 时清理覆盖表）+ 父 turn 中断级联 + send 窗口期注入缓冲；**P5b** 看板 UI——AgentBoard 组件（状态四态流转/摘要/授权 allow|deny|always/中断），子 agent 权限授权闭环，bridge 数据面（agents-status/agent-interrupt/快照重同步）；单测 140 条全绿、e2e 9 用例全绿（新增看板 2 用例）、typecheck 全绿、真测冒烟通过（DeepSeek 真实模型并行派发 2 explorer 子代理汇总，12,068 tokens）；详设见 docs/specs/orchestration.md。
- **P4 已实施**（2026-08-29）：P4a 桌面壳 + **P4b 增强体验**——diff 视图（core 结构化 diff + 行级渲染）、reasoning 折叠块、token 用量角标、工具卡片实时输出流（tool/stream）、设置页（provider/model、API Key 写 credentials.json，renderer 不持有 key）、会话侧栏（多会话：会话绑定 cwd、切换保留历史、事件不串）、Ask/Agent/Quest 模式切换（即时生效不追溯）、electron-builder Windows 打包（asar + NSIS）；单测 125 条全绿（core 23 条新增）、e2e 7 用例全绿（新增 diff / 模式切换 / 多会话）、typecheck 全绿、打包产物冒烟通过；详见 docs/specs/desktop.md §10.2.7/10.2.8。
- **P4a 已实施**（2026-08-29）：Electron 桌面壳最小可用 GUI——main/preload/renderer 三层（electron-vite 构建，contextIsolation + preload 白名单 + CSP 安全基线）；Op/EventMsg IPC 协议落地 + renderer 刷新状态重同步；聊天主区流式渲染、工具卡片、权限卡片三态（allow/deny/always + waiting-permission 状态机）、中断按钮、cwd 选择；验收三连（GUI 闭环 / 权限三态 / 中断无残留）由 Playwright Electron e2e 4 用例全自动断言，真测冒烟（DeepSeek 真实模型 GUI 闭环，权限卡片 2 次确认）通过。
- **P3 已实施**（2026-08-29）：插件生态化——外部插件加载（`config.plugins` 支持 npm 包名/本地路径，全局配置限定，失败不中断启动）；示范插件 `@heluo-code/plugin-web-fetch`（`web_fetch` 工具，seam 三角色：契约=core 导出类型、实现=插件包、消费=agentLoop）；provider 注册制佐证（新增 provider 零核心改动）；外部插件与内置权限插件 pre-execute 链共存；插件卸载（dispose）无残留（工具注销、瀑布钩子与事件监听全部反注册，自动化断言）；89 条测试全绿（新增 12 条）。
- **P2 已实施**（2026-08-29）：工具集全量（6/6）——edit_file / list_dir / grep_search / run_command 补齐，Windows shell 实测定稿（Q2 关闭）；权限全量——run_command 命令首 token 前缀 always 记忆、Quest 可配 `questRunCommand`、`tools.exclude`/`grepMaxResults`/`runCommandMaxTimeoutMs`/`editRequiresRead` 配置生效；优雅退出（interrupt → 5s 等待 → 进程树强杀 → 日志闭合）；`tool/stream` 实时输出事件、`post-execute` 钩子；77 条测试全绿（含闭环场景自动断言）。
- **真测冒烟已通过**（2026-08-29）：CLI 端到端跑通「写脚本→运行报错→修复→再运行」闭环（DeepSeek V4 Flash，11,009 tokens），并修复真测暴露的 5 处缺陷（AI SDK v7 instructions 适配、permissions 同步响应竞态、CLI EOF 退出/退订时机/prompt 崩溃）与评审整改 3 项（gitignore 目录栈、taskkill 兜底、API/文档/测试卫生），详见 docs/SPEC.md §11 P2。
- 待办：P6 产品化（**P6-0a 写限制沙箱已落地**；网络隔离 P6-0b、resume/fork/replay、上下文压缩、MCP、shell 环境快照、mac/linux 打包等）。

## 仓库结构（当前阶段）

```
packages/
  core/    @heluo-code/core  —— 无头核心：Cordis 插件内核 + session/llm/tools/agentLoop/agents 服务
                               + config/permissions/system-prompt/tools-fs/tools-shell/tools-spawn/llm-openai-compatible/llm-mock/plugin-loader 插件
  cli/     @heluo-code/cli   —— 开发调试 REPL（P2：6 工具全量、权限确认、优雅退出）
  plugin-web-fetch/
           @heluo-code/plugin-web-fetch —— P3 示范外部插件：web_fetch 工具（npm 包名/本地路径经 config.plugins 加载）
  desktop/ @heluo-code/desktop —— P4 Electron 桌面：main（boot core + IPC bridge 多会话）/ preload（contextBridge 白名单）
                               / renderer（React：流式、diff、reasoning 折叠、token 角标、权限卡片、中断、cwd、多会话侧栏、模式切换、设置页）
```

`packages/desktop` 构建说明与 e2e 基础设施见 [`docs/specs/desktop.md`](docs/specs/desktop.md)。

## 配置与运行说明

- 全局配置：`~/.heluo-code/config.jsonc`
- 项目级配置：`<cwd>/.heluo-code/config.jsonc`（优先级：项目 > 全局 > 内置默认；CLI 参数可覆盖）
- 支持 JSONC（注释 / 尾逗号）与 `{env:VAR}` 占位替换；字段与合并语义见 [`docs/specs/config.md`](docs/specs/config.md)
- `providers` / `plugins` 安全边界、AGENTS.md 自动发现已在 **P1** 生效
- 本地开发避开 C 盘：用环境变量 `HELUO_CODE_HOME` 覆盖全局配置目录（如指向项目内 `.heluo-code/`），详见 [`docs/specs/config.md`](docs/specs/config.md)
- 临时开发文件放仓库内 `tmp/`（已 gitignore）
- 测试临时数据落仓库根 `test-tmp/`（已 gitignore；测试 mkdtemp 以 `import.meta.dirname` 定位，不写系统 tmpdir/C 盘）——**所有临时文件一律放当前工作区，禁止写 C 盘系统目录**，详见仓库根 `AGENTS.md`
- 打包产物 `packages/desktop/release/` 已 gitignore（安装包不入库）

## 已知工程取舍（dev-only）

- **`pnpm-workspace.yaml` 的 `dangerouslyAllowAllBuilds: true`**：当前 pnpm v11 的 `allowBuilds` 无法批准传递依赖（esbuild 经 vitest/tsx 引入）的构建脚本，故放开以允许 esbuild 的 postinstall。依赖均经锁定且可信，非生产发布项；待 pnpm 修复 `allowBuilds` 对传递依赖的匹配后，可收敛为 `allowBuilds: ['esbuild']`。
- **TypeScript `moduleResolution: Bundler`**：P0 经 tsx / vitest 运行、不 emit 产物；若未来需 tsc 真正产出 `dist/`（如 P4 桌面打包），再评估切回 NodeNext 并补 `.js` 扩展名。**发布前提**：workspace 包 exports 均指向 `./src/*.ts`，真实 npm 发布前需构建产物并更新 exports（P6 打包项）。
- **`@heluo-code/core` devDep ↔ `@heluo-code/plugin-web-fetch` dep 循环**：P3 验收要求「npm 包名加载」需 core 测试侧能解析该包，故 core 以 devDependencies 引入（插件依赖 core 为正常方向）。pnpm 以 junction 链接处理（`git status --ignored` 可能刷 "Filename too long"，node_modules 已被 gitignore，不影响提交）；运行时无循环（插件对 core 仅 type-only import，编译后被擦除）。发布后用户侧安装插件则无此循环。
- **desktop main 构建将 core 源码 bundle 进产物**：core 的 exports 指向 `./src/*.ts`（TS 源码），Electron 无法直接加载，故 `electron.vite.config.ts` 的 `externalizeDepsPlugin({ exclude: ['@heluo-code/core'] })` 让构建期编译 core 进 `out/main/index.js`（core 包零改动）；core 的第三方依赖（ai/@cordisjs/core/zod 等）保持 external 由 node_modules 加载，**electron-builder 打包时自动收集进 asar**（desktop 以 dependencies 显式声明运行依赖集）。若未来发布 mac/linux 安装包，再评估 core 产出 dist（NodeNext + `.js` 扩展名）。
- **desktop preload 为 ESM 产物（`index.mjs`），窗口需 `sandbox: false`**：electron-vite 5 默认 ESM 输出；安全基线由 contextIsolation + preload 白名单承担（renderer 无 Node 能力、不接触 core），CSP 已配置。若需恢复 sandbox，可配置 preload 输出 CJS。
- **`koffi` 为 sandbox runner 的 FFI 依赖**（prebuilt 免编译链；dsh sandbox-windows-acl 同款验证）：runner 经 koffi 调 Win32 API（CreateRestrictedToken/CreateProcessAsUserW/ACL/job）。core 与 desktop 均显式声明依赖（desktop 因 runner 从 `out/sandbox/` 解析 node_modules 需要）。已知 koffi 3.1.6 bug：`koffi.decode(ptr, 'string16')` native crash，须用 `koffi.decode.string16()`。
- **desktop 构建复制 sandbox runner 到 `out/sandbox/`**：runner 是独立 node 脚本（core 的 RUNNER_PATH 从 out/main 相对解析 `../../../sandbox/runner.mjs`）；Electron 下 spawn 带 `ELECTRON_RUN_AS_NODE=1` 以 node 模式运行。打包（asar）场景的 runner/koffi 资源分发在 P6-0b 验证。
- **Windows Defender 实时扫描可能锁定打包输出目录**（EBUSY）：仓库内 `release/` 打包偶发失败，属本机环境问题；可输出到系统 temp 目录规避（`--config.directories.output=<temp路径>`）。

## 参考

- [`docs/SPEC.md`](docs/SPEC.md) — 主契约（架构 / 决策 / 领域模型 / 分阶段计划）
- [`docs/specs/interfaces.md`](docs/specs/interfaces.md) — 接口类型（Tool / LLM seam / Agent / Op / EventMsg）
- [`docs/specs/tools.md`](docs/specs/tools.md) — 内置工具集
- [`docs/specs/permissions.md`](docs/specs/permissions.md) — 权限系统
- [`docs/specs/config.md`](docs/specs/config.md) — 配置系统
- [`docs/specs/desktop.md`](docs/specs/desktop.md) — 桌面客户端详规（P4a 落地版：进程模型 / IPC / 安全基线 / 验收对照）
- [`docs/specs/orchestration.md`](docs/specs/orchestration.md) — 多 agent 编排详规（P5a：agents 服务 / spawn_subagent / 并发排队 / Q5 权限继承 / 看板 UI 契约）
- [`docs/specs/sandbox.md`](docs/specs/sandbox.md) — 沙箱与会话持久化详规（P6-0：写限制双模式 / 降级链 / 实测结论 / 边界披露 / 验收对照）
