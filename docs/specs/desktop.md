# SPEC 详规：客户端（desktop）

> 归属：docs/SPEC.md §10.2
> 本文件是主契约的按域详规；交叉契约（架构/决策/服务骨架/接口类型）以主文档 `../SPEC.md` 为准。
> 返回：../SPEC.md

---

## 10.2 Desktop（packages/desktop，P4 主交付物）

> 状态：**P4 已实施（2026-08-29）**——P4a 最小可用 GUI（聊天流式 + 权限卡片三态 + 中断 + cwd 选择）与
> P4b 增强体验（diff 视图 / reasoning 折叠 / token 角标 / 工具实时输出流 / 设置页 / 会话侧栏多会话 / Ask/Agent/Quest 模式切换 / electron-builder 打包）全部落地。
> vitest 125 全绿 + e2e 7 用例全绿（含 diff、模式切换、多会话不串事件）+ 打包产物冒烟通过。

### 10.2.1 进程模型与安全基线

```
main 进程：boot(core profile) → 持有唯一 Context → ipcMain 处理 Op → webContents.send 推 EventMsg
preload：contextBridge 暴露白名单 API { submit(op), onEvent(cb), getSnapshot(), pickCwd() }
renderer：React SPA，仅经 preload API 通信，绝不接触 core 内部对象
```

安全基线（R5）：
- `contextIsolation: true` + `nodeIntegration: false`；renderer 不持有 apiKey（P4b 设置页写 credentials.json）
- preload 仅白名单 4 个 API，不暴露 ipcRenderer/Node
- `sandbox: false`：因 preload 采用 ESM 产物（electron-vite 输出 `index.mjs`）；隔离能力由 contextIsolation + 白名单承担
- renderer 页面带 CSP（default-src 'self'；script-src 'self'；style-src 'self' 'unsafe-inline'）
- 模型输出按纯文本渲染（P4b 引入 Markdown 白名单，禁 raw HTML/script）

### 10.2.2 IPC 协议

传输通道（channel 常量在 `src/shared/ipc.ts`）：

| 通道 | 方向 | 载荷 |
|---|---|---|
| `heluo:op` | renderer → main（send） | `Op` |
| `heluo:event` | main → renderer（send） | `EventMsg` |
| `heluo:snapshot` | renderer → main（invoke） | 返回 `{ sessionId, cwd, events, sessions }` |
| `heluo:pick-cwd` | renderer → main（invoke） | 返回选中目录或 null |
| `heluo:config-get` | renderer → main（invoke） | 返回 `ConfigSnapshot`（model / providers / permissionMode） |
| `heluo:config-set` | renderer → main（invoke） | 更新 model / permissionMode（仅白名单字段） |
| `heluo:credentials-set` | renderer → main（invoke） | 写 `~/.heluo-code/credentials.json`（main 侧落盘，0600） |

```ts
type Op =
  | { type: 'user-turn'; sessionId: string; text: string }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'permission-decision'; requestId: string; decision: 'allow' | 'deny' | 'always' }
  | { type: 'create-session' }                    // 新建会话（同当前 cwd）并激活（P4b）
  | { type: 'switch-session'; sessionId: string } // 切换会话（P4b）

type EventMsg =
  | { type: 'session-event'; event: SessionEvent }   // SessionEvent 转发，UI 状态唯一驱动源
  | { type: 'cwd-changed'; cwd: string }
  | { type: 'sessions-changed'; sessions: SessionInfo[] } // 会话列表/激活态变化（P4b）
```

语义：
- **事件流驱动 UI，从不轮询**（§3.3）；权限请求/响应即 `permission/request`、`permission/response` 会话事件，经同一流转发
- **刷新重同步**：renderer 启动先 `getSnapshot()` 全量重放当前会话日志，再订阅 `heluo:event` 增量；快照同时携带 sessionId/cwd/sessions 列表（初始 cwd 广播存在竞态，故并入快照）
- **多会话（P4b）**：main 持有 `Map<sessionId, SessionStore>`，**事件仅转发 active 会话**（切换会话不串事件）；`user-turn`/`interrupt` 按 sessionId 路由；renderer 收到 `sessions-changed` 且 active 变化时重拉快照全量重放
- **会话绑定 cwd**：`pickCwd`/换目录 = 新建会话（绑定新 cwd）并激活，旧会话保留历史可回切
- `interrupt` → `agentLoop.interrupt(sessionId)`（内部维护 AbortController；权限等待中 abort 由 permissions 插件兜底 deny，§8）
- **模式切换（P4b）**：`config-set {permissionMode}` → core `config.update`（内存级），permissions 每次 pre-execute 实时读 mode——**即时生效、不追溯已放行操作**（specs/permissions.md §8.3）
- **凭据（P4b）**：设置页 API Key 经 `credentials-set` 交 main 写盘，renderer 不持有 apiKey（安全基线 R5）；core `loadApiKey` 按 `apiKeyEnv`（env）> `credentials.json` 回退读取（specs/config.md）
- 退出：`window-all-closed` → bridge.dispose()（移除监听/订阅）→ `app.shutdown()`（§5.8 优雅退出）

### 10.2.3 main 进程

- 启动流程：`resolveCwd()`（`HELUO_CODE_E2E_CWD` → `userData/cwd.txt` 持久化 → `dialog.showOpenDialog` 选目录）→ `boot({ cwd })` → 创建窗口 → `attachBridge` → 加载 renderer（dev 走 `ELECTRON_RENDERER_URL`，生产 `out/renderer/index.html`）
- `attachBridge`（`src/main/bridge.ts`）为纯逻辑模块（不依赖 electron 运行环境），在 vitest 中以 mock 的 ipcMain/webContents 装配测试
- **多会话（P4b）**：`Map<sessionId, SessionStore>` + active 切换（`create-session`/`switch-session` Op）；事件仅转发 active 会话；`setCwd` = 新建会话（绑定新 cwd）并激活；`writeCredentials` 写 `~/.heluo-code/credentials.json`（JSON，0600，renderer 不接触 key）
- 构建：electron-vite 三端构建；`@heluo-code/core` 的 exports 指向 TS 源码（`./src/*.ts`），main 构建时**排除 externalize**、由构建期 bundle 进 `out/main/index.js`（core 包零改动，见 README 已知取舍）
- **打包（P4b）**：`electron-builder.yml`（appId `com.heluo.code`、asar、NSIS）；`files` 含 `out/**` + `package.json`，core 的运行时依赖（ai/@cordisjs/core/zod 等）自动收集进 asar；`pnpm --filter @heluo-code/desktop package` 产出 `release/heluo-code-<version>-setup.exe`；产物自包含验证：asar 含三端产物 + 依赖，Playwright 冒烟启动 win-unpacked 完成一轮 turn（不触网）

### 10.2.4 renderer（React SPA）

- 状态机：`src/renderer/src/session.ts` 纯 reducer（SessionEvent 流 → UI 状态），从空状态重放全量事件即得 UI 状态——刷新重同步与实时增量同一条路径；单测覆盖
- 消息流：user 消息 / assistant 流式（chunk 按 stepId 累积）/ 工具卡片（call → result，running/done/error 三态）
- **reasoning 折叠块（P4b）**：`reasoning/chunk` 按 stepId 累积，挂在对应 assistant 消息前，默认收起可展开（`<details>`）
- **token 角标（P4b）**：`turn/end.usage` 落位 `lastTurnEnd`，topbar 显示 totalTokens（title 含 prompt/completion 明细）
- **工具实时输出流（P4b）**：`tool/stream` 按 callId 累积显示于 running 卡片；result 到达后以完整 output 为准
- **diff 视图（P4b）**：`tool/result.diff`（core 产出 `{ path, before, after }`，FileDiff 随事件流转发）→ `DiffView` 行级 +/−/context 纯文本渲染（无第三方依赖，满足 CSP）
- 权限卡片：`permission/request` → 置 `waiting-permission` 态并弹卡（单卡串行）；allow/deny/always 三按钮 → `permission-decision`；`permission/response` 清除卡片（abort 兜底 deny 时同样走此路径，无残留 pending）
- 中断按钮：turn 活跃（running / waiting-permission）时显示，发送 `Op.interrupt`；`turn/end` 后恢复可输入
- **模式切换（P4b）**：topbar Ask/Agent/Quest 三态按钮组（`config-set {permissionMode}`，turn 中也可切换——即时生效）
- **设置页（P4b）**：modal 面板（provider/model 保存 + API Key 经 IPC 交 main 写 credentials.json；renderer 不持有 key）
- **会话侧栏（P4b）**：左侧栏会话列表（cwd + 激活态）+ 新建；`sessions-changed` 驱动列表，active 变化时重拉快照
- cwd 顶栏：显示当前工作目录 + 更换按钮（`pickCwd`）
- 无 UI 框架（手写 CSS）、纯文本渲染（无 Markdown 渲染器）

### 10.2.5 构建、运行与测试

```bash
pnpm dev:desktop        # electron-vite dev（HMR）
pnpm build:desktop      # 产物 out/{main,preload,renderer}
pnpm test:e2e           # build + Playwright Electron e2e（7 用例）
pnpm test               # vitest 单测（renderer reducer + main bridge，125 条全仓）
pnpm --filter @heluo-code/desktop package  # electron-builder 打包（release/heluo-code-<version>-setup.exe）
```

e2e 基础设施（不触网）：
- `HELUO_CODE_E2E_MOCK=1` 时 main 挂 `llmMockPlugin` 并 `registerMockStepScript`（脚本定义于 `src/main/e2e-mock.ts`，复用 P2 场景闭环结构；mock 只 mock LLM，工具真实执行）
- `HELUO_CODE_E2E_SCRIPT` 选择脚本；`HELUO_CODE_E2E_CWD` 指定工作目录（跳过对话框）
- e2e 目录 `e2e/app.spec.ts` 由 Playwright 独立运行（vitest 配置 `vitest.config.ts` 限定 `src/**/*.test.ts`，二者不互相污染）

### 10.2.6 P4a 验收对照

| SPEC §11 P4a 验收 | 落点 |
|---|---|
| 脱离 CLI，GUI 完成 P2 同款闭环（含权限卡片、中断） | e2e 闭环用例：mock 闭环脚本 + 4 次权限卡片 allow，断言工具卡片序列与磁盘文件；真测冒烟：DeepSeek 真实模型 GUI 完成写脚本→运行（2 次权限确认） |
| 权限卡片 allow/deny/always 三态与 waiting-permission 状态机一致 | e2e 权限三态用例（always 记忆 / allow 不记忆 / deny 拒绝）+ session reducer 单测 |
| 中断 GUI 任务时 agentLoop.interrupt 解挂且不残留 pending 卡片 | e2e 中断①（权限等待中停止）、中断②（工具执行中停止），均断言 turn interrupted + 卡片消失 + 可再输入 |

### 10.2.7 P4b 已实施（2026-08-29）

- **diff 视图**：core `tools-fs` 的 write_file/edit_file 产出结构化 diff（`ToolOutcome.diff` = `{ path, before, after }`，`outputForModel` 摘要文本不变），随 `tool/result` 事件流转发；renderer `DiffView` 行级渲染（无第三方库）
- **reasoning 折叠块**：`reasoning/chunk` 按 stepId 累积（与 assistant/chunk 同 stepId），挂载到对应消息前，`<details>` 默认收起
- **token 用量角标**：`turn/end.usage` 展示于 topbar（`tokens N`，title 含输入/输出明细）
- **工具卡片实时输出流**：`tool/stream` 按 callId 累积显示；result 后以完整输出为准
- **设置页**：provider/model 保存（`config-set`）+ API Key 写 `~/.heluo-code/credentials.json`（`credentials-set`，main 侧 0600 落盘）；core `loadApiKey` 按 env > credentials.json 回退读取（补上 config.md 声明的凭据链）
- **会话侧栏（多会话）**：会话绑定 cwd、切换保留历史；事件仅转发 active 会话（不串事件）；快照携带 sessions 列表
- **Ask/Agent/Quest 模式切换**：core `config.update`（内存级）→ permissions 实时读 mode 即时生效（specs/permissions.md §8.3）；topbar 三态按钮
- **electron-builder 打包**（Windows）：asar + NSIS，产物自包含（core bundle 进 main + 运行时依赖收集），win-unpacked 冒烟通过

### 10.2.8 P4b 验收对照

| SPEC §11 P4b 验收 | 落点 |
|---|---|
| 完整覆盖 §10.2 功能清单 | 上表逐项落地（vitest 125 全绿 + e2e 7 用例全绿 + typecheck 全绿） |
| 三级模式切换即时生效且语义符合 specs/permissions.md §8.3 | core 单测（update 后下一次 pre-execute 按新模式判定、非法 patch 拒绝）+ bridge 单测（config-set 白名单字段）+ e2e（等待授权中 agent→quest，后续写操作不弹卡） |
| diff 展示 + 多会话切换状态自洽（切换不串事件） | e2e diff 用例（write 全 add / edit 有 del+add）+ e2e 多会话用例（双会话交替、历史恢复、事件不串）+ bridge 单测（非 active 会话 turn 不转发） |