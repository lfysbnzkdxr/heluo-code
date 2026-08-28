# SPEC 详规：配置系统（config）

> 归属：docs/SPEC.md §9
> 本文件是主契约的按域详规；交叉契约（架构/决策/服务骨架/接口类型）以主文档 `../SPEC.md` 为准。
> 返回：../SPEC.md

---

## 9. 配置系统规格

### 9.1 文件布局与优先级

```
优先级从高到低：
CLI 参数  >  <project>/.heluo-code/config.jsonc  >  ~/.heluo-code/config.jsonc  >  内置默认值
凭据：环境变量 HELUO_CODE_<PROVIDER>_API_KEY  >  ~/.heluo-code/credentials.json（gitignore + 提示 0600）
```

**安全边界（防恶意仓库配置，P1 起生效）**：`providers` 与 `plugins` 两个字段**仅允许在全局配置（`~/.heluo-code/config.jsonc`）中声明，项目级 config 不可覆盖**——从结构上杜绝 clone 的恶意仓库把模型指向攻击者 endpoint 或加载恶意插件路径。项目级 config 其余字段（model、permission.mode、loop、tools 等）可覆盖。首次加载项目级 config 时：CLI 打印信任提示并要求确认；桌面端弹信任确认卡（P6 增强体验项），未确认前按全局配置运行。

支持 JSONC（注释）；借鉴 opencode 支持 `{env:VAR}` 占位替换。

### 9.2 Schema（要点）

```jsonc
{
  "model": "deepseek/deepseek-chat",          // 格式: "<adapterId>/<modelName>"，按首个 "/" 分割；adapterId 须对应 providers 中已声明项
  "providers": {
    "deepseek": {
      "type": "openai-compatible",
      "baseURL": "https://api.deepseek.com/v1",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "contextWindow": 65536        // 可选；用于计算上下文软上限（softCap = 窗口 × 0.9，见 SPEC §5.2），未知时默认 32K
    },
    "qwen":     { "type": "openai-compatible", "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1", "models": ["qwen3-coder-plus"] },
    "kimi":     { "...": "..." },
    "glm":      { "...": "..." },
    "ollama":   { "type": "openai-compatible", "baseURL": "http://localhost:11434/v1", "models": ["qwen3-coder:30b"] }
  },
  "plugins": ["@heluo-code/plugin-web-fetch", "./local-plugin"],   // P3
  "permission": { "mode": "agent" },
  "loop": { "maxStepsPerTurn": 40 },
  "rules": ["./AGENTS.md"],                        // 附加指令文件路径（数组）；v1 默认已自动发现项目根 AGENTS.md 与全局 ~/.heluo-code/AGENTS.md，此字段为额外引入/覆盖；单文件上限 32 KiB
  "tools": { "exclude": [] , "grepMaxResults": 100, "outputTruncateHead": 500, "outputTruncateTail": 500 }
}
```

### 9.3 分层合并语义

对象深合并、数组整体覆盖（与常见惯例一致）；合并结果一次性解析校验（zod），非法配置启动即失败并列出路径。
