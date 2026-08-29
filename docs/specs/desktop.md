# SPEC 详规：客户端（desktop）

> 归属：docs/SPEC.md §10.2
> 本文件是主契约的按域详规；交叉契约（架构/决策/服务骨架/接口类型）以主文档 `../SPEC.md` 为准。
> 返回：../SPEC.md

---

## 10.2 Desktop（packages/desktop，P4 主交付物）

> 状态：**P4a 已实施（2026-08-29）**——最小可用 GUI 打通闭环（聊天流式 + 权限卡片三态 + 中断 + cwd 选择），
> mock e2e 4 用例全绿（闭环 / 权限三态 / 中断①②）+ 真测冒烟通过（DeepSeek 真实模型 GUI 闭环，2 次权限确认）。
> P4b（diff 视图 / reasoning 折叠 / token 角标 / 设置页 / 会话侧栏 / Ask/Agent/Quest 模式切换）待实施。

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
| `heluo:snapshot` | renderer → main（invoke） | 返回 `{ sessionId, cwd, events }` |
| `heluo:pick-cwd` | renderer → main（invoke） | 返回选中目录或 null |

```ts
type Op =
  | { type: 'user-turn'; sessionId: string; text: string }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'permission-decision'; requestId: string; decision: 'allow' | 'deny' | 'always' }

type EventMsg =
  | { type: 'session-event'; event: SessionEvent }   // SessionEvent 转发，UI 状态唯一驱动源
  | { type: 'cwd-changed'; cwd: string }
```

语义：
- **事件流驱动 UI，从不轮询**（§3.3）；权限请求/响应即 `permission/request`、`permission/response` 会话事件，经同一流转发
- **刷新重同步**：renderer 启动先 `getSnapshot()` 全量重放当前会话日志，再订阅 `heluo:event` 增量；快照同时携带 sessionId 与 cwd（初始 cwd 广播存在竞态，故并入快照）
- 单会话（P4a）：`Op.sessionId` 与当前会话不匹配时静默忽略（P4b 多会话再扩）
- `interrupt` → `agentLoop.interrupt(sessionId)`（内部维护 AbortController；权限等待中 abort 由 permissions 插件兜底 deny，§8）
- 退出：`window-all-closed` → bridge.dispose()（移除监听/订阅）→ `app.shutdown()`（§5.8 优雅退出）

### 10.2.3 main 进程

- 启动流程：`resolveCwd()`（`HELUO_CODE_E2E_CWD` → `userData/cwd.txt` 持久化 → `dialog.showOpenDialog` 选目录）→ `boot({ cwd })` → 创建窗口 → `attachBridge` → 加载 renderer（dev 走 `ELECTRON_RENDERER_URL`，生产 `out/renderer/index.html`）
- `attachBridge`（`src/main/bridge.ts`）为纯逻辑模块（不依赖 electron 运行环境），在 vitest 中以 mock 的 ipcMain/webContents 装配测试
- 工作目录切换：`pickCwd` → `createSession(newCwd)` 重建会话并重订阅（run_command 等工具的 cwd 为 session.cwd）
- 构建：electron-vite 三端构建；`@heluo-code/core` 的 exports 指向 TS 源码（`./src/*.ts`），main 构建时**排除 externalize**、由构建期 bundle 进 `out/main/index.js`（core 包零改动，见 README 已知取舍）

### 10.2.4 renderer（React SPA）

- 状态机：`src/renderer/src/session.ts` 纯 reducer（SessionEvent 流 → UI 状态），从空状态重放全量事件即得 UI 状态——刷新重同步与实时增量同一条路径；单测覆盖
- 消息流：user 消息 / assistant 流式（chunk 按 stepId 累积）/ 工具卡片（call → result，running/done/error 三态）
- 权限卡片：`permission/request` → 置 `waiting-permission` 态并弹卡（单卡串行）；allow/deny/always 三按钮 → `permission-decision`；`permission/response` 清除卡片（abort 兜底 deny 时同样走此路径，无残留 pending）
- 中断按钮：turn 活跃（running / waiting-permission）时显示，发送 `Op.interrupt`；`turn/end` 后恢复可输入
- cwd 顶栏：显示当前工作目录 + 更换按钮（`pickCwd`）
- P4a 无 UI 框架（手写 CSS）、纯文本渲染（Markdown 渲染列入 P4b）

### 10.2.5 构建、运行与测试

```bash
pnpm dev:desktop        # electron-vite dev（HMR）
pnpm build:desktop      # 产物 out/{main,preload,renderer}
pnpm test:e2e           # build + Playwright Electron e2e（4 用例）
pnpm test               # vitest 单测（renderer reducer + main bridge，13 条）
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

### 10.2.7 P4b 待实施

- diff 视图（write/edit 工具卡片）、reasoning 折叠块（DeepSeek R 类）、token 用量角标
- 工具卡片实时输出流（`tool/stream` 事件，CLI 已有；P4a reducer 丢弃，P4b 接入流式显示）
- 设置页（provider/model 选择、API Key 写 credentials.json）、会话侧栏（多会话 + 切换）、Ask/Agent/Quest 模式切换
- 多会话时 Op.sessionId 校验放开；EventMsg 按 sessionId 分发
- electron-builder 打包（Windows 优先；打包触发 core/cli 切 NodeNext 产出 dist 的评估，见 README 已知取舍）