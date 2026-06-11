import type { ReliquaryApi } from './index'

declare global {
  interface Window {
    reliquary: ReliquaryApi
  }
}

export {}
