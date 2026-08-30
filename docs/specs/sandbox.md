# 沙箱与会话持久化详规（P6-0）

> 归属 SPEC.md §5.2（会话持久化）与 §11 P6-0（进程级沙箱）/ §13 R8。
> 版本：v1.1 ｜ 日期：2026-08-30 ｜ 状态：P6-0-pre 持久化 ✅ + P6-0a 写限制 ✅（restricted-write/job 双模式落地）；P6-0b 网络隔离进行中

## 1. 背景与目标

- **R8 闭环**：`run_command` 此前仅以「权限 ask + cwd 软约束 + 命令白名单」为防线（工具层软约束），本阶段引入 **OS 级强制**：
  - 文件写：`WRITE_RESTRICTED` 受限令牌（双通过写检查，普通用户可用）
  - 网络：专用沙箱用户 + Windows 防火墙出站规则（P6-0b，需一次性管理员 setup）
  - 进程树：`KILL_ON_JOB_CLOSE` Job Object（OS 保证进程树必死）
- **SPEC §5.2 缺口闭合**：JSONL 每会话一文件持久化（写盘 + 加载 + 容错），为 P6-1 resume/fork/replay 提供底座。

## 2. 威胁模型与边界（披露）

| 能力 | 状态 | 说明 |
|---|---|---|
| 写 cwd 外 | **被 OS 拒绝** | WRITE_RESTRICTED 双通过写检查 |
| 破坏性命令（rm -rf 等） | 权限 ask 把关（P2 已有） | cwd 内破坏不受沙箱限制（设计如此） |
| 读 cwd 外 | 不受限 | WRITE_RESTRICTED 只拦写。**披露** |
| 网络 | P6-0b（isolated 模式） | 防火墙按沙箱用户 SID 拦出站；loopback 不受限 |
| 提权 | 受限令牌去特权（DISABLE_MAX_PRIVILEGE） | 无管理员能力可利用 |
| Everyone 环境写 | **存在 gap** | 目录若已授予 Everyone 写，双检查仍通过（codex/dsh 同款边界） |
| hardlink 别名 | **存在 gap** | 文件对象别名绕过路径 ACL（pnpm store 场景） |
| FAT 卷 | **不支持** | 无 ACL；种 ACE 失败 → fail-closed 拒绝执行 |
| 受限进程内 spawn pipe | **受限** | 受限令牌下新匿名管道 pass-2 写检查失败（EPERM；dsh 用 DefaultDacl 合并规避，本方案 stdio 采用继承直通故不受影响） |
| whoami /all | 报错噪音 | 受限令牌 GetTokenInformation 部分不可用，非功能故障 |
| ACE 残留 | 惰性 | workspace ACE standing（幂等 skip，每目录每机一次）；temp ACE 随目录删除消失 |

## 3. 架构与模式

```
heluo-code 主进程（普通用户即可）
├── ctx.sandbox（seam，SandboxService.spawn(argv, { cwd, writableRoots })）
│   ├── mode 'off'              → 裸 spawn（透传）
│   ├── mode 'job'              → spawn node runner.mjs --mode job
│   │     CreateProcessW + JOB_LIST 属性（EXTENDED_STARTUPINFO_PRESENT）
│   │     KILL_ON_JOB_CLOSE + 活动进程上限 16 → 进程树 OS 必杀（无需特权）
│   ├── mode 'restricted-write' → spawn node runner.mjs --mode restricted
│   │     CreateRestrictedToken(WRITE_RESTRICTED) → 种 workspace/temp ACE →
│   │     CreateProcessAsUserW(受限 token) + CREATE_SUSPENDED → AssignProcessToJobObject → ResumeThread
│   └── mode 'isolated'（P6-0b）→ restricted-write + 防火墙网络隔离（需一次性管理员 setup）
└── tools-shell run_command → sandbox.spawn（替换裸 spawn 调用点）
```

**关键实测结论（2026-08-30，win32 普通用户非管理员）**：

1. **`CreateProcessAsUserW` + 调用者自身的受限 token 在普通用户下可用**（无需 SE_ASSIGNPRIMARYTOKEN/SE_INCREASE_QUOTA，Windows 实际豁免比文档宽；文档要求见 MSDN CreateProcessAsUserW「restricted version of the caller's primary token」）。dsh sandbox-windows-acl 同款机制。
2. `CreateProcessW` + PROC_THREAD_ATTRIBUTE_TOKEN **不可用**（现代 Windows 不支持该属性，实测 ERROR_INVALID_PARAMETER 87）。
3. AppContainer（SECURITY_CAPABILITIES）机制可用但 **cmd/powershell/node 全部 STATUS_DLL_INIT_FAILED (0xC0000142)**，普通 CLI 工具兼容性硬伤，否决。
4. `koffi.decode(ptr, 'string16')` 触发 native crash（koffi 3.1.6 bug），必须用 `koffi.decode.string16()`。
5. 受限进程 stdio 采用**继承直通**（GetStdHandle + SetHandleInformation 置 inheritable），无 dsh 的管道 DefaultDacl 问题；`SetTokenInformation(TokenDefaultDacl)` 在本机普通用户报 error 5（codex 社区亦见 1344 类问题），**不启用**（实测继承直通下受限进程完全正常）。
6. **Electron（GUI 子系统）父进程下 restricted 模式不可用**（受限 console 子进程 0xC0000142，已实测排除 token/DefaultDacl/环境/句柄/job 差异——root cause 收敛于 GUI 父进程的控制台分配路径）；sandbox 服务按 `process.versions.electron` 检测自动降级 job（进程树必杀保持）。**e2e 的 mock 场景不依赖 run_command 真实输出，曾掩盖此问题**（开发期排查记录）。

**降级与 fail-closed 语义**：

| 场景 | 行为 |
|---|---|
| 非 win32 | mode 强制 'off' + 启动 logger.warn（工具层软约束兜底） |
| **Electron（GUI 子系统父进程）+ restricted-write/isolated** | **降级 job** + warn——GUI 父进程创建 console 受限子进程时控制台分配失败，子进程 0xC0000142（实测；与 dsh 的 console isolation 限制同族）；CLI（纯 node console 进程）完整可用 |
| isolated 未配置 setup（P6-0b 前） | warn + 按 restricted-write 执行（写限制完整生效） |
| runner 初始化失败（令牌/ACL/进程创建） | **拒绝执行** + stderr `sandbox-run: <detail>` + exit 127；tools-shell 识别并报「沙箱初始化失败，命令未执行（fail-closed）」+ 提示切换 job/off |

## 4. 会话持久化（P6-0-pre，SPEC §5.2 落地）

- **路径**：`<HELUO_CODE_HOME>/sessions/<sessionId>.jsonl`（HELUO_CODE_HOME 默认 `~/.heluo-code`）
- **写盘**：`sessions.create` 时 `mkdirSync` + 持有 fd（`'a'`）；`append()` 同步写每事件一行；写盘失败 `logger.error` + 内存继续（内存为权威，文件为持久副本）
- **加载**：`SessionService.resume(sessionId, cwd)` — 逐行 parse：坏行/半截尾行跳过 + warn；`schemaVersion` 不匹配拒绝；未知事件类型跳过 + warn（`SESSION_EVENT_TYPES` 运行时校验）；恢复后 `deriveMessages` 投影与写盘前一致
- **生命周期**：文件只增不减；`SessionStore.close()` 关 fd（幂等，测试/未来 resume 用）；进程退出 OS 清理
- **崩溃语义**：半截 `assistant/chunk`/未闭合 `step/start` 加载后不投影（derive 语义天然满足，有断言）

## 5. 配置（config schema `sandbox` 段）

```ts
sandbox: {
  mode: z.enum(['off', 'job', 'restricted-write', 'isolated']),  // 默认 'restricted-write'
  writableRoots: z.array(z.string()),                             // 默认 []，附加写根（绝对路径）
}
```

- 会话 cwd 始终是写根（runner `--workspace`）
- `writableRoots` 供需写 cwd 外路径的场景（如构建缓存目录）

## 6. 运行机制（runner.mjs）

- **形态**：纯 JS `node runner.mjs --mode <job|restricted> --workspace <abs> [--writable-root <abs>]... -- <argv...>`（core 包 `sandbox/runner.mjs` 静态资源；desktop 构建时复制到 `out/sandbox/`，Electron 下经 `ELECTRON_RUN_AS_NODE=1` 以 node 模式运行）
- **restricted 模式**：
  - `CreateRestrictedToken(当前 token, DISABLE_MAX_PRIVILEGE|LUA_TOKEN|WRITE_RESTRICTED)`，restricting SIDs = `[logonSID, Everyone, workspaceSID, tempSID]`（前两者 keep-alive，缺失 DLL 初始化 0xC0000142）
  - logon SID 从 TokenGroups 提取并 **CopySid 复制**（防 GC 悬垂）
  - workspace/temp 派生 SID：`sha256(canonicalPath)` → `S-1-4-21-<4 words>`（每目录每机稳定）；`SetEntriesInAclW` 合并（幂等）+ exact-ACE skip 避免重复全树传播；temp ACE 随 temp 目录删除消失
  - `CreateProcessAsUserW`（受限 token）+ `CREATE_SUSPENDED` → `AssignProcessToJobObject`（KILL_ON_JOB_CLOSE + ActiveProcessLimit 16）→ `ResumeThread`；stdio 继承直通（SetHandleInformation 置 inheritable，Node 启动会清除）
  - `TMP/TEMP` 重写为私有 temp 目录（授予 tempSID 写）
- **job 模式**：`CreateProcessW` + `PROC_THREAD_ATTRIBUTE_JOB_LIST`（EXTENDED_STARTUPINFO_PRESENT）——无需特权
- **fail-closed**：任何 Win32 失败 → `sandbox-run: <detail>` + exit 127；KILL_ON_JOB_CLOSE 的 job 句柄必须保持打开到子进程退出（早关会立即杀全树）

## 7. setup 与网络隔离（P6-0b，进行中）

- `heluo-code sandbox:setup`（CLI 子命令；桌面设置页按钮经 main 进程 `Start-Process -Verb RunAs`）：
  1. 建 `HeluoSandboxOffline` 本地用户（随机密码存 `<HELUO_CODE_HOME>/sandbox.json` 0600；已存在跳过）→ 添加「允许本地登录」
  2. `New-NetFirewallRule` 出站 Block（`-LocalUser <OfflineUserSID>`，幂等）
  3. 启动常驻 elevated helper（named pipe 收 SpawnRequest → `CreateProcessAsUserW` 沙箱用户 + stdio 转发 + KILL_ON_JOB_CLOSE）
- 沙箱用户身份 = 文件隔离（workspace 种读+写 ACE）+ 防火墙用户规则 = 网络隔离（出站拒绝；loopback 不受限）；本版 Offline 单轨（Online 双轨列 P6-0c）

## 8. 验收对照表（全部自动化断言）

| # | 域 | 断言 | 状态 |
|---|---|---|---|
| 1 | pre | 写盘：文件存在 / 行数一致 / 每行可解析 / schemaVersion 正确 | ✅ vitest |
| 2 | pre | resume roundtrip：事件序列与投影一致；半截尾行跳过 + warn；schemaVersion 不匹配拒绝 | ✅ vitest |
| 3 | a | 写 cwd 内成功；写 cwd 外（兄弟目录）被 OS 拒绝（EPERM/DENIED） | ✅ vitest（真实进程） |
| 4 | a | 进程树必杀：命令派生孙进程 → runner 退出 → 孙进程被 job 强杀（DEAD 断言） | ✅ vitest（真实进程） |
| 5 | a | fail-closed：runner 初始化失败 → 127 + `sandbox-run:` 前缀；tools-shell 报「沙箱初始化失败」 | ✅ vitest |
| 6 | a | 退出码透传（exit 3）；UTF-8 中文输出；超时/中断杀进程树不挂起 | ✅ vitest |
| 7 | a | e2e 回归：9 用例全绿（Electron 内 runner 经 ELECTRON_RUN_AS_NODE 运行；Electron 环境自动降级 job 路径） | ✅ e2e |
| 8 | a | 回归：157 单测全绿 + typecheck 全绿 | ✅ |
| 8b | a | 打包冒烟：electron-builder 产物（asar 内 runner + koffi native 经 asarUnpack 加载）；job 模式实测可用（win-unpacked ELECTRON_RUN_AS_NODE 冒烟） | ✅ |
| 9 | b | setup 幂等；规则与用户存在断言；沙箱身份断言；出站被拒；workspace 读写 | P6-0b（admin skipIf） |
| 10 | 全 | 真测冒烟（DeepSeek 真实模型） | 待 P6-0b 后 |

## 9. 已知限制与后续

- Online/Offline 双轨（联网命令经授权走 Online 用户）→ P6-0c
- macOS/Linux 沙箱（Seatbelt/Landlock）→ P6-6
- desktop 打包（asar）下 runner 的资源分发与 koffi native 模块加载：**已验证**——closeBundle 复制 runner 到 out/sandbox（asar 内）+ `@koromix/koffi-win32-x64` 显式 optionalDependencies（electron-builder 收集，native 经 asarUnpack）；win-unpacked 以 ELECTRON_RUN_AS_NODE 冒烟 job 模式通过；**Electron 环境 restricted 模式不可用（自动降级 job，见 §3）**
- `SetTokenInformation(TokenDefaultDacl)` 在普通用户报 error 5 且本方案不依赖（继承直通 stdio）——若未来需支持受限进程内新管道（如 node 脚本 spawn pipe 捕获），需特权环境或改用其他方案
- `koffi` 为新增 FFI 依赖（prebuilt，免编译链；dsh 已验证同款）→ README 已知取舍记录
- 测试隔离：`test-setup.ts` 将 HELUO_CODE_HOME 指向 `test-tmp/home`（各包 vitest.config 显式声明 setupFiles——vitest 4 projects 模式根配置不继承）
