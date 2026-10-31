import type { DailyUsageStats, ProjectTokenStats } from '@/tauri/token-usage'
import { calculateModelUsageCost, normalizeModelName } from './token-pricing'

export type ModelProviderId = 'codex' | 'antigravity' | 'claude' | 'deepseek' | 'other'

/** Classify the model itself, independently of the agent that ran it. */
export function getModelProvider(rawModel: string): ModelProviderId {
  const model = normalizeModelName(rawModel)
  if (/\bdeepseek\b/.test(model)) return 'deepseek'
  if (/\b(?:claude|opus|sonnet|haiku|fable)\b/.test(model)) return 'claude'
  if (/\bgemini\b/.test(model)) return 'antigravity'
  if (/\b(?:gpt|codex)\b|\bo[134](?:\b|[-.])/.test(model)) return 'codex'
  return 'other'
}

export interface ProviderUsageSummary {
  providerId: ModelProviderId
  promptCount: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  totalTokens: number
  cost: number
}

export interface ProviderModelUsage extends ProviderUsageSummary {
  model: string
}

function emptyUsage(providerId: ModelProviderId): ProviderUsageSummary {
  return {
    providerId,
    promptCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    cost: 0,
  }
}

function addUsage(target: ProviderUsageSummary, source: Omit<ProviderUsageSummary, 'providerId'>): void {
  target.promptCount += source.promptCount
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.cacheTokens += source.cacheTokens
  target.totalTokens += source.totalTokens
  target.cost += source.cost
}

/** Merge the same model across agents, pricing each original record on its date. */
export function summarizeDailyModelUsage(day: DailyUsageStats): ProviderModelUsage[] {
  const models = new Map<string, ProviderModelUsage>()
  for (const model of day.models) {
    const providerId = getModelProvider(model.model)
    // Keep raw agent IDs intact while presenting legacy free variants as the same model.
    const displayModel = providerId === 'deepseek'
      ? model.model.replace(/-free(?=\s*(?:\(|$))/i, '')
      : model.model
    const key = JSON.stringify([providerId, displayModel])
    let usage = models.get(key)
    if (!usage) {
      usage = { ...emptyUsage(providerId), model: displayModel }
      models.set(key, usage)
    }
    addUsage(usage, { ...model, cost: calculateModelUsageCost(model, day.date) })
  }
  return [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens)
}

/** Model-family totals for both historical and newly collected agent records. */
export function summarizeProjectProviderUsage(project: ProjectTokenStats): ProviderUsageSummary[] {
  const providers = new Map<ModelProviderId, ProviderUsageSummary>()
  for (const day of project.dailyStats) {
    for (const model of summarizeDailyModelUsage(day)) {
      let usage = providers.get(model.providerId)
      if (!usage) {
        usage = emptyUsage(model.providerId)
        providers.set(model.providerId, usage)
      }
      addUsage(usage, model)
    }
  }
  return [...providers.values()].sort((a, b) => b.totalTokens - a.totalTokens)
}

/** Rank days by their token subtotal; keep newer dates first when totals match. */
export function sortDailyUsageByTokens(days: DailyUsageStats[]): DailyUsageStats[] {
  return [...days].sort((a, b) => b.totalTokens - a.totalTokens || b.date.localeCompare(a.date))
}
