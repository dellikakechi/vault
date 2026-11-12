import type { VaultApi } from '@shared/api'

declare global {
  interface Window {
    vault: VaultApi
    __vault?: Record<string, unknown>
  }
}

export {}
