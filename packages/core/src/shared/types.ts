export interface Profile {
  cwd: string
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export type { Config, ProviderConfig } from '../plugins/config/schema'
