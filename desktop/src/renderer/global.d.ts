import type { CoopApi } from '../shared/api'

declare global {
  interface Window {
    coop: CoopApi
  }
}

export {}
