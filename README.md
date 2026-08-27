# heluo-code

从零实现的 AI 编程助手 harness（无头核心 + 薄客户端）。架构 / 决策 / 领域模型 / 分阶段计划见 [`docs/SPEC.md`](docs/SPEC.md)（主契约），接口 / 工具 / 权限 / 配置等密度高详规见 [`docs/specs/`](docs/specs)。

## 环境要求

- Node.js ≥ 20.19（已验证 24.x 可用）
- pnpm（安装其一即可）：`corepack enable`，或 `npm i -g pnpm`

## 快速开始

```bash
pnpm install        # 安装依赖（首次会运行 esbuild 的 postinstall）
pnpm dev            # 启动 CLI 空 REPL（bin: heluo-code）
pnpm test           # 运行 vitest 单元测试
pnpm typecheck      # tsc 严格类型检查（core + cli）
```

## 仓库结构（当前阶段）

```
packages/
  core/    @heluo-code/core  —— 无头核心（Cordis 插件内核、config 插件、boot 入口）
  cli/     @heluo-code/cli   —— 开发调试 REPL（P0 空 REPL，agent loop 待 P1）
```

`packages/desktop`（Electron 桌面壳）按规划推迟至 **P4** 实施，P0 不建。

## 配置与运行说明

- 全局配置：`~/.heluo-code/config.jsonc`
- 项目级配置：`<cwd>/.heluo-code/config.jsonc`（优先级：项目 > 全局 > 内置默认；CLI 参数可覆盖）
- 支持 JSONC（注释 / 尾逗号）与 `{env:VAR}` 占位替换；字段与合并语义见 [`docs/specs/config.md`](docs/specs/config.md)
- `providers` / `plugins` 安全边界、AGENTS.md 自动发现按规格在 **P1** 生效，P0 仅做最小加载
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
