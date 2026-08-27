# SPEC 详规：权限系统（permissions）

> 归属：docs/SPEC.md §8
> 本文件是主契约的按域详规；交叉契约（架构/决策/服务骨架/接口类型）以主文档 `../SPEC.md` 为准。
> 返回：../SPEC.md

---

## 8. 权限系统规格

### 8.1 双轨模型（借鉴 codex：沙箱管能不能，审批管问不问）

v1 无 OS 级沙箱，「能不能」降级为两层软边界：
1. 工作目录约束：Quest 模式下写操作限定在 cwd 子树内；
2. 工具级策略：deny 直接拒绝执行。

「问不问」由审批钩子链决定。

### 8.2 瀑布钩子链（D7）

`tools/pre-execute` 为 waterfall 事件：监听器依次获得 `(toolName, args, decision)`，必须调用 `next()` 放行；任一监听器可不调 next 而直接给出最终裁决（allow/deny/ask）。内置 permissions 插件是该链条的第一个消费者，未来的 MCP 策略、审计日志、危险命令检测都是追加监听器即可。

### 8.3 三级模式映射（Qoder 借鉴）

| 模式 | 读类工具 | 写类工具(write/edit) | run_command | 适用场景 |
|---|---|---|---|---|
| Ask | allow | ask | ask | 只读问答、解释代码 |
| Agent（默认） | allow | ask | ask | 日常结对协作 |
| Quest | allow | allow(cwd 子树内) | ask(可配为 allow) | 明确任务的放手委托 |

模式切换即时生效（Op.set-mode），作用于后续审批判定，不追溯已放行操作。

### 8.4 always 记忆

用户选择 always 后的记忆粒度按工具区分（廉价高收益，避免「全工具级 always」的越权风险）：
- **run_command**：记录「命令首 token 前缀」（如 `npm` / `git` 放行，`rm` / `curl` 仍每次询问），既保留放权便利又避免 `rm -rf` 类命令被静默放行。
- **write_file / edit_file**：按「工具名」粒度记忆（v1 简化，已知局限：不区分目标路径；不受信仓库建议用 Agent 模式而非 always）。`run_command` 的命令级白名单细化列为 P6 评估项。

**作用域（设计选择，非遗漏）**：always 记忆为**全局生效**（跨项目共享）。这是 v1 的简化取舍；已知局限是项目 A 的授权会带到项目 B（含写入系统目录等路径）。项目级作用域隔离列为 P6 评估项。

UI 需在授权卡片明示记忆范围与边界。

### 8.5 权限事件闭环

每次 ask 都产生成对日志事件（`permission/request` → `permission/response`），保证轨迹可回放、resume 后待决审批可重建。等待审批期间 agent 状态为 `waiting-permission`，可被 interrupt。
