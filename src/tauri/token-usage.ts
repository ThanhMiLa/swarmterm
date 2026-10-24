import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface PromptTurnRecord {
  turnKey: string
  agentId: string
  model: string
  projectPath: string
  date: string
  timestampMs: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  totalTokens: number
}

export interface ModelUsageStats {
  agentId: string
  model: string
  promptCount: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  totalTokens: number
}

export interface DailyUsageStats {
  date: string
  promptCount: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  totalTokens: number
  models: ModelUsageStats[]
}

export interface ProjectTokenStats {
  projectPath: string
  projectName: string
  totalPrompts: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheTokens: number
  totalTokens: number
  lastPrompt?: PromptTurnRecord | null
  dailyStats: DailyUsageStats[]
}

export interface TokenUsageResponse {
  projects: ProjectTokenStats[]
  overallLastPrompt?: PromptTurnRecord | null
  totalAllTokens: number
}

export const getTokenUsageStats = (): Promise<TokenUsageResponse> =>
  invoke('get_token_usage_stats')

export const onTokenUsageUpdated = (
  callback: (stats: TokenUsageResponse) => void
): Promise<UnlistenFn> =>
  listen<TokenUsageResponse>('token-usage:updated', (event) => callback(event.payload))
