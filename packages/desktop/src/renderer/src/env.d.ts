import type { PreloadApi } from '../../shared/ipc'

declare global {
  interface Window {
    heluo: PreloadApi
  }
}

export {}