# SPEC 详规：内置工具集（tools）

> 归属：docs/SPEC.md §7
> 本文件是主契约的按域详规；交叉契约（架构/决策/服务骨架/权限/接口类型）以主文档 `../SPEC.md` 为准。
> 返回：../SPEC.md
> 实现状态：P1 已交付 §7.1 read_file 与 §7.2 write_file（含 cwd 软约束）；§7.3–7.6 于 P2 交付（SPEC §11 P2）。

---

## 7. 内置工具集规格

命名与粒度对标 Claude Code 工具集（被大规模验证的设计）。所有工具输出进模型前经过长度截断：默认保留头部 + 尾部各 **500 行**（可配置 `tools.outputTruncateHead` / `tools.outputTruncateTail`），中间以 `...[truncated N lines]...` 标注。

**编码基线（v1）**：文件默认以 **UTF-8** 读写。`read_file` 对无效 UTF-8 字节序列以替换符（U+FFFD）输出（P1 最小实现，不逐字节保真、不附警告）；`write_file` 始终以 UTF-8 写入（结果中注明编码）。按原字节保真输出并附警告、自动编码探测（识别 GBK/UTF-16 并保留原编码写回）列为 P6 增强——避免非 UTF-8 项目文件被写入破坏。

### 7.1 read_file ｜ 权限：allow

| 参数 | 类型 | 说明 |
|---|---|---|
| path | string | 相对 cwd 或绝对路径 |
| offset | number? | 起始行（1-based） |
| limit | number? | 读取行数，默认至 `maxReadLines=2000` |

行为：输出带行号（`cat -n` 风格）；检测二进制文件（NUL 字节启发式）则报错建议用 run_command；超出截断上限时提示用 offset/limit 分页。

### 7.2 write_file ｜ 权限：ask

| 参数 | 类型 | 说明 |
|---|---|---|
| path | string | 目标文件 |
| content | string | 完整内容 |

行为：整文件覆写；父目录不存在则自动创建；成功返回写入字节数。

### 7.3 edit_file ｜ 权限：ask

| 参数 | 类型 | 说明 |
|---|---|---|
| path | string | 目标文件 |
| old_string | string | 必须精确匹配且唯一 |
| new_string | string | 替换文本 |
| replace_all | boolean? | 默认 false |

行为：`old_string` 匹配 0 处或 >1 处（且未开 replace_all）时报错并列出匹配数量，引导模型加长上下文锚定；要求同会话内先 read 过该文件（软约束：未读时返回警告性错误，可被配置关闭）。

### 7.4 list_dir ｜ 权限：allow

| 参数 | 类型 | 说明 |
|---|---|---|
| path | string | 默认 "." |
| depth | number? | 递归深度，默认 1 |

行为：忽略 `.git`/`node_modules`/`dist` 等默认排除项（可配置）；标注目录/文件与大小。

### 7.5 grep_search ｜ 权限：allow

| 参数 | 类型 | 说明 |
|---|---|---|
| pattern | string | JS 正则 |
| path | string? | 搜索根，默认 "." |
| include | string? | 文件 glob，如 `"*.ts"` |
| max_results | number? | 默认 100 |

行为：纯 Node 实现（递归遍历 + 逐行正则），输出 `path:line: text`；遵守 list_dir 同款排除项与 .gitignore（尽力而为）。

### 7.6 run_command ｜ 权限：ask

| 参数 | 类型 | 说明 |
|---|---|---|
| command | string | 完整 shell 命令行 |
| timeout_ms | number? | 默认 60000，硬上限 900000（可在配置 `tools.runCommandMaxTimeoutMs` 调整） |
| cwd | string? | 默认会话 cwd |

行为：Windows 下经 PowerShell 执行（`powershell.exe -NoProfile -Command`；P0/P2 期间实测 git-bash/conda 场景后定稿）；捕获 stdout/stderr 合并输出并附退出码；超时杀进程树；不承诺后台常驻进程（P6 评估 persistent terminal）；**stdout/stderr 实时流式推送给 UI**，便于用户判断进度并自行中断。**stdin 为 null/关闭**：v1 不向命令透传交互输入；若命令需交互（如 `git commit` 打开编辑器、`npm init` 问答），由模型在命令行参数中预设（如 `git commit -m '...'`），否则会因无输入而失败或超时——此为预期安全行为。
