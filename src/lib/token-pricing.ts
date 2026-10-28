/**
 * Token Pricing Engine for Swarmterm
 *
 * Implements published pricing from:
 * - OpenAI (Codex): gpt-6-astra, gpt-6.1-sol, gpt-6-sol, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna
 * - Google DeepMind (Antigravity): Gemini 4 Argon, Gemini 3.8 Flash (with date-based promo pricing)
 * - Anthropic: Claude Opus 5.5, Claude Sonnet 5.5, Claude Fable 5.1, Claude Haiku 5.5
 *
 * Rates are stored in USD per 1,000,000 (1M) tokens for:
 * 1. inputTokens (Uncached Prompt tokens)
 * 2. outputTokens (Completion + Thinking / Reasoning tokens)
 * 3. cacheTokens (Prompt Caching Read / Hits & Refreshes)
 */

export interface ModelPricing {
  inputPerMillion: number
  outputPerMillion: number
  cachePerMillion: number
  displayName?: string
}

/**
 * Remove reasoning effort in parentheses, e.g. "gpt-6.1-sol (high)" -> "gpt-6.1-sol"
 */
export function normalizeModelName(rawModel: string): string {
  if (!rawModel) return ''
  return rawModel
    .replace(/\s*\([^)]*\)/g, '')
    .trim()
    .toLowerCase()
}

/**
 * Static pricing tables for models without date-based transitions
 */
const STATIC_PRICING_TABLE: Record<string, ModelPricing> = {
  // --- OpenAI / Codex Models ---
  'gpt-6-astra': {
    inputPerMillion: 10.0,
    outputPerMillion: 50.0,
    cachePerMillion: 1.0,
    displayName: 'GPT-6 Astra',
  },
  'gpt-6.1-sol': {
    inputPerMillion: 2.0,
    outputPerMillion: 10.0,
    cachePerMillion: 0.1,
    displayName: 'GPT-6.1 Sol',
  },
  'gpt-6-sol': {
    inputPerMillion: 2.0,
    outputPerMillion: 10.0,
    cachePerMillion: 0.2,
    displayName: 'GPT-6 Sol',
  },
  'gpt-6-luna': {
    inputPerMillion: 0.1,
    outputPerMillion: 0.5,
    cachePerMillion: 0.01,
    displayName: 'GPT-6 Luna',
  },
  'gpt-5.6-sol': {
    inputPerMillion: 4.0,
    outputPerMillion: 20.0,
    cachePerMillion: 0.4,
    displayName: 'GPT-5.6 Sol',
  },
  'gpt-5.6-terra': {
    inputPerMillion: 2.0,
    outputPerMillion: 12.0,
    cachePerMillion: 0.2,
    displayName: 'GPT-5.6 Terra',
  },
  'gpt-5.6-luna': {
    inputPerMillion: 0.2,
    outputPerMillion: 1.2,
    cachePerMillion: 0.02,
    displayName: 'GPT-5.6 Luna',
  },
  'codex-auto-review': {
    inputPerMillion: 0.1,
    outputPerMillion: 0.5,
    cachePerMillion: 0.01,
    displayName: 'Codex Auto Review',
  },

  // OpenAI fallback / older models
  'o3-mini': {
    inputPerMillion: 1.1,
    outputPerMillion: 4.4,
    cachePerMillion: 0.55,
    displayName: 'o3-mini',
  },
  'o1': {
    inputPerMillion: 15.0,
    outputPerMillion: 60.0,
    cachePerMillion: 7.5,
    displayName: 'o1',
  },
  'gpt-4o': {
    inputPerMillion: 2.5,
    outputPerMillion: 10.0,
    cachePerMillion: 1.25,
    displayName: 'GPT-4o',
  },
  'gpt-4o-mini': {
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
    cachePerMillion: 0.075,
    displayName: 'GPT-4o mini',
  },

  // --- Anthropic Models ---
  'claude-opus-5.5': {
    inputPerMillion: 4.0,
    outputPerMillion: 20.0,
    cachePerMillion: 0.2,
    displayName: 'Claude Opus 5.5',
  },
  'claude-sonnet-5.5': {
    inputPerMillion: 2.0,
    outputPerMillion: 10.0,
    cachePerMillion: 0.1,
    displayName: 'Claude Sonnet 5.5',
  },
  'claude-fable-5.1': {
    inputPerMillion: 10.0,
    outputPerMillion: 50.0,
    cachePerMillion: 0.25,
    displayName: 'Claude Fable 5.1',
  },
  'claude-haiku-5.5': {
    inputPerMillion: 0.1,
    outputPerMillion: 0.5,
    cachePerMillion: 0.01,
    displayName: 'Claude Haiku 5.5',
  },

  // Anthropic fallback / standard Claude 3 / 3.5 / 3.7 models
  'claude-3-7-sonnet': {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cachePerMillion: 0.3,
    displayName: 'Claude 3.7 Sonnet',
  },
  'claude-3-5-sonnet': {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cachePerMillion: 0.3,
    displayName: 'Claude 3.5 Sonnet',
  },
  'claude-3-5-haiku': {
    inputPerMillion: 0.8,
    outputPerMillion: 4.0,
    cachePerMillion: 0.08,
    displayName: 'Claude 3.5 Haiku',
  },
  'claude-3-opus': {
    inputPerMillion: 15.0,
    outputPerMillion: 75.0,
    cachePerMillion: 1.5,
    displayName: 'Claude 3 Opus',
  },

  // --- Google / Antigravity Fallbacks ---
  'gemini-2.5-pro': {
    inputPerMillion: 1.25,
    outputPerMillion: 5.0,
    cachePerMillion: 0.3125,
    displayName: 'Gemini 2.5 Pro',
  },
  'gemini-2.5-flash': {
    inputPerMillion: 0.075,
    outputPerMillion: 0.3,
    cachePerMillion: 0.01875,
    displayName: 'Gemini 2.5 Flash',
  },
  'gemini-1.5-pro': {
    inputPerMillion: 1.25,
    outputPerMillion: 5.0,
    cachePerMillion: 0.3125,
    displayName: 'Gemini 1.5 Pro',
  },
  'gemini-1.5-flash': {
    inputPerMillion: 0.075,
    outputPerMillion: 0.3,
    cachePerMillion: 0.01875,
    displayName: 'Gemini 1.5 Flash',
  },
}

/**
 * Fallback pricing if an unrecognized model is encountered
 */
const DEFAULT_FALLBACK_PRICING: ModelPricing = {
  inputPerMillion: 1.0,
  outputPerMillion: 5.0,
  cachePerMillion: 0.1,
  displayName: 'Standard Model',
}

/**
 * Resolve pricing for a model on a given ISO date (YYYY-MM-DD).
 * Accurately handles Google DeepMind promotional date cutoffs.
 */
export function getModelPricing(rawModel: string, dateStr?: string): ModelPricing {
  const norm = normalizeModelName(rawModel)
  const normHyphen = norm.replace(/\s+/g, '-')

  // 1. Check Gemini 4 Argon (Cutoff: Nov 30, 2026)
  if (normHyphen.includes('gemini-4-argon') || norm.includes('gemini 4 argon')) {
    const isPostPromo = dateStr ? dateStr > '2026-11-30' : false
    if (isPostPromo) {
      return {
        inputPerMillion: 4.0,
        outputPerMillion: 20.0,
        cachePerMillion: 0.2,
        displayName: 'Gemini 4 Argon',
      }
    }
    return {
      inputPerMillion: 2.0,
      outputPerMillion: 10.0,
      cachePerMillion: 0.1,
      displayName: 'Gemini 4 Argon',
    }
  }

  // 2. Check Gemini 3.8 Flash (Cutoff: Dec 31, 2026)
  if (normHyphen.includes('gemini-3.8-flash') || norm.includes('gemini 3.8 flash')) {
    const isPostPromo = dateStr ? dateStr > '2026-12-31' : false
    if (isPostPromo) {
      return {
        inputPerMillion: 1.5,
        outputPerMillion: 7.5,
        cachePerMillion: 0.15,
        displayName: 'Gemini 3.8 Flash',
      }
    }
    return {
      inputPerMillion: 0.75,
      outputPerMillion: 3.75,
      cachePerMillion: 0.075,
      displayName: 'Gemini 3.8 Flash',
    }
  }

  // 3. Exact key match in static pricing table
  if (STATIC_PRICING_TABLE[normHyphen]) {
    return STATIC_PRICING_TABLE[normHyphen]
  }
  if (STATIC_PRICING_TABLE[norm]) {
    return STATIC_PRICING_TABLE[norm]
  }

  // 4. Prefix / Substring matching for Claude models
  if (norm.includes('opus 5.5') || normHyphen.includes('opus-5.5')) {
    return STATIC_PRICING_TABLE['claude-opus-5.5']
  }
  if (norm.includes('sonnet 5.5') || normHyphen.includes('sonnet-5.5')) {
    return STATIC_PRICING_TABLE['claude-sonnet-5.5']
  }
  if (norm.includes('fable 5.1') || normHyphen.includes('fable-5.1')) {
    return STATIC_PRICING_TABLE['claude-fable-5.1']
  }
  if (norm.includes('haiku 5.5') || normHyphen.includes('haiku-5.5')) {
    return STATIC_PRICING_TABLE['claude-haiku-5.5']
  }
  if (norm.includes('sonnet') && norm.includes('3.7')) {
    return STATIC_PRICING_TABLE['claude-3-7-sonnet']
  }
  if (norm.includes('sonnet')) {
    return STATIC_PRICING_TABLE['claude-3-5-sonnet']
  }
  if (norm.includes('haiku')) {
    return STATIC_PRICING_TABLE['claude-3-5-haiku']
  }
  if (norm.includes('opus')) {
    return STATIC_PRICING_TABLE['claude-3-opus']
  }

  // 5. Prefix / Substring matching for Codex models
  for (const key of Object.keys(STATIC_PRICING_TABLE)) {
    if (normHyphen.startsWith(key) || normHyphen.includes(key)) {
      return STATIC_PRICING_TABLE[key]
    }
  }

  // 6. Generic fallback
  return DEFAULT_FALLBACK_PRICING
}

/**
 * Calculate token cost in USD for a given usage.
 *
 * Formula:
 * (inputTokens * inputPrice + outputTokens * outputPrice + cacheTokens * cachePrice) / 1,000,000
 */
export function calculateTokenCost(
  rawModel: string,
  inputTokens: number,
  outputTokens: number,
  cacheTokens: number,
  dateStr?: string
): number {
  const pricing = getModelPricing(rawModel, dateStr)
  const inputCost = (inputTokens * pricing.inputPerMillion) / 1_000_000
  const outputCost = (outputTokens * pricing.outputPerMillion) / 1_000_000
  const cacheCost = (cacheTokens * pricing.cachePerMillion) / 1_000_000
  return inputCost + outputCost + cacheCost
}

/**
 * Calculate total cost in USD for a single ModelUsageStats entry on a specific date.
 */
export function calculateModelUsageCost(
  modelStat: { model: string; inputTokens: number; outputTokens: number; cacheTokens: number },
  dateStr?: string
): number {
  return calculateTokenCost(
    modelStat.model,
    modelStat.inputTokens,
    modelStat.outputTokens,
    modelStat.cacheTokens,
    dateStr
  )
}

/**
 * Calculate total cost in USD for a day across all models used that day.
 */
export function calculateDailyCost(day: {
  date: string
  models: Array<{ model: string; inputTokens: number; outputTokens: number; cacheTokens: number }>
}): number {
  return day.models.reduce((sum, m) => sum + calculateModelUsageCost(m, day.date), 0)
}

/**
 * Calculate total cost in USD for an entire project across all daily stats.
 */
export function calculateProjectCost(project: {
  dailyStats: Array<{
    date: string
    models: Array<{ model: string; inputTokens: number; outputTokens: number; cacheTokens: number }>
  }>
}): number {
  return project.dailyStats.reduce((sum, day) => sum + calculateDailyCost(day), 0)
}

/**
 * Calculate cost breakdown by agent across an entire project.
 */
export function calculateProjectAgentCosts(project: {
  dailyStats: Array<{
    date: string
    models: Array<{
      agentId: string
      model: string
      inputTokens: number
      outputTokens: number
      cacheTokens: number
    }>
  }>
}): Record<string, number> {
  const result: Record<string, number> = {}
  for (const day of project.dailyStats) {
    for (const m of day.models) {
      const cost = calculateModelUsageCost(m, day.date)
      result[m.agentId] = (result[m.agentId] || 0) + cost
    }
  }
  return result
}

/**
 * Calculate cost breakdown by agent for a single day.
 */
export function calculateDailyAgentCosts(day: {
  date: string
  models: Array<{
    agentId: string
    model: string
    inputTokens: number
    outputTokens: number
    cacheTokens: number
  }>
}): Record<string, number> {
  const result: Record<string, number> = {}
  for (const m of day.models) {
    const cost = calculateModelUsageCost(m, day.date)
    result[m.agentId] = (result[m.agentId] || 0) + cost
  }
  return result
}

/**
 * Format currency amount into human-friendly USD string:
 * - $0.00 if zero
 * - 4 decimal places if < $0.01 (e.g. $0.0042)
 * - 2 decimal places with thousands separators if >= $0.01 (e.g. $1.25, $1,420.50)
 */
export function formatCurrency(amount: number): string {
  if (!amount || amount <= 0 || isNaN(amount)) {
    return '$0.00'
  }
  if (amount < 0.01) {
    return '$' + amount.toFixed(4)
  }
  return '$' + amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
