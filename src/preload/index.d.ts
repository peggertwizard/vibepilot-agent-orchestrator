import type { VibePilotApi } from './index'

declare global {
  interface Window {
    vibepilot: VibePilotApi
  }
}

export {}
