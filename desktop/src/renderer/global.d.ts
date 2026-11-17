import type { CoopApi } from '../shared/api'

declare global {
  const __BUILD_ID__: string
  interface Window {
    coop: CoopApi
  }
}

export {}
