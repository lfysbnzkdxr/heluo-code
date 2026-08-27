export interface Profile {
  cwd: string
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export interface ProviderConfig {
  type: string
  baseURL?: string
  models?: string[]
  apiKeyEnv?: string
}

export interface LoopConfig {
  maxStepsPerTurn: number
}

export interface ToolsConfig {
  exclude: string[]
  grepMaxResults: number
  outputTruncateHead: number
  outputTruncateTail: number
}

export interface PermissionConfig {
  mode: 'ask' | 'agent' | 'quest'
}

export interface Config {
  model: string
  providers: Record<string, ProviderConfig>
  plugins: string[]
  permission: PermissionConfig
  loop: LoopConfig
  rules: string[]
  tools: ToolsConfig
}
