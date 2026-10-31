import { invoke } from '@tauri-apps/api/core'

/** The saved choice and the result of applying it to the live app window. */
export interface InputCompatibilityStatus {
  supported: boolean
  enabled: boolean
  currentEnabled: boolean | null
  applied: boolean
  error?: string
}

export const getInputCompatibility = (): Promise<InputCompatibilityStatus> =>
  invoke('get_input_compatibility')

export const setInputCompatibility = (enabled: boolean): Promise<InputCompatibilityStatus> =>
  invoke('set_input_compatibility', { enabled })
