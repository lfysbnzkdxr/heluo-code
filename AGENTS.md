# heluo-code 项目工作区约定

> 本文件由 AI 助手在新对话中自动读取，作为项目级行为约定。
> 项目背景与进度见 `README.md`；主契约（架构/决策/领域模型/分阶段计划）见 `docs/SPEC.md`，按域详规见 `docs/specs/`。

## 文件落盘位置（重要）

**所有临时文件一律放当前工作区（仓库）内，禁止写 C 盘系统目录：**

- 开发/调试/冒烟等临时文件 → 仓库根 `tmp/`（已 gitignore）
- 测试运行时产生的临时数据 → 仓库根 `test-tmp/`（已 gitignore）
- 不要使用 `os.tmpdir()`（C:\Users\...\AppData\Local\Temp）存放任何项目数据；
  测试代码统一用 `TEST_TMP` 常量（以 `import.meta.dirname` 定位仓库根 `test-tmp/`，定义时 `mkdirSync` 幂等创建）
- 会话/配置等用户数据默认 `~/.heluo-code/`；本地开发避开 C 盘可用 `HELUO_CODE_HOME` 覆盖到仓库内目录

## 阶段推进惯例（沿用 P0–P5 流程）

1. **详设先行**：新阶段启动时先落规格（主契约 `docs/SPEC.md` 或外置详规 `docs/specs/<域>.md`），明确验收标准，评审确认后再实现
2. **实现 + 测试同步**：每个能力点带 vitest 单测；GUI 相关带 Playwright e2e（mock provider，不触网）
3. **文档回写**：阶段验收后同步 `docs/SPEC.md`（版本号/§11 状态/Q 表）与 `README.md`（进度/测试条数）
4. **提交**：`git status`/`git diff` 检查后按仓库风格提交（`feat(pX): ...` / `docs: ...`，提交信息含验收结论）

## 验证命令（提交前必跑）

- `pnpm test` — vitest 全量单测
- `pnpm typecheck` — 全包严格类型检查
- `pnpm test:e2e` — 构建 + Playwright Electron e2e（改动 GUI 相关时）
- `pnpm --filter @heluo-code/desktop package` — electron-builder 打包冒烟（改动打包配置时）

## 真测冒烟惯例

- 需真实 API Key 时：仅以本次会话环境变量提供（如 `DEEPSEEK_API_KEY`），**不回写配置文件**；冒烟日志中的 key 痕迹需清除
- 冒烟产物（日志/脚本）放 `tmp/`，不入库

## 工程注意

- pnpm workspace + Node ≥ 20.19；`.npmrc`/`pnpm-workspace.yaml` 的取舍见 README「已知工程取舍」（dev-only，勿随意改动）
- 外部插件加载（P3）仅全局配置允许声明 providers/plugins（安全边界，specs/config.md §9.1）
- 会话/编排服务按 Cordis effect 注册，dispose 需无残留（新增注册类能力时保持此纪律）
