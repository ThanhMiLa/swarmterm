import { describe, expect, it } from 'vitest'
import type { DailyUsageStats, ModelUsageStats, ProjectTokenStats } from '@/tauri/token-usage'
import { calculateDailyCost, calculateProjectCost } from './token-pricing'
import { getModelProvider, sortDailyUsageByTokens, summarizeDailyModelUsage, summarizeProjectProviderUsage } from './token-usage-summary'

function model(agentId: string, name: string): ModelUsageStats {
  return {
    agentId,
    model: name,
    promptCount: 2,
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheTokens: 500_000,
    totalTokens: 1_600_000,
  }
}

function day(date: string, models: ModelUsageStats[]): DailyUsageStats {
  return {
    date,
    models,
    promptCount: models.reduce((sum, m) => sum + m.promptCount, 0),
    inputTokens: models.reduce((sum, m) => sum + m.inputTokens, 0),
    outputTokens: models.reduce((sum, m) => sum + m.outputTokens, 0),
    cacheTokens: models.reduce((sum, m) => sum + m.cacheTokens, 0),
    totalTokens: models.reduce((sum, m) => sum + m.totalTokens, 0),
  }
}

function project(dailyStats: DailyUsageStats[]): ProjectTokenStats {
  return {
    projectPath: '/workspace',
    projectName: 'workspace',
    totalPrompts: dailyStats.reduce((sum, d) => sum + d.promptCount, 0),
    totalInputTokens: dailyStats.reduce((sum, d) => sum + d.inputTokens, 0),
    totalOutputTokens: dailyStats.reduce((sum, d) => sum + d.outputTokens, 0),
    totalCacheTokens: dailyStats.reduce((sum, d) => sum + d.cacheTokens, 0),
    totalTokens: dailyStats.reduce((sum, d) => sum + d.totalTokens, 0),
    dailyStats,
  }
}

describe('model provider usage', () => {
  it('ranks provider and model rows by tokens even when the cheaper model has more usage', () => {
    const stats = day('2026-10-31', [
      model('codex', 'gpt-6-astra'),
      model('opencode', 'deepseek-v4.1-flash'),
      model('opencode', 'deepseek-v4.1-flash'),
    ])
    const providers = summarizeProjectProviderUsage(project([stats]))
    expect(providers.map((row) => row.providerId)).toEqual(['deepseek', 'codex'])
    expect(providers[0].cost).toBeLessThan(providers[1].cost)
    expect(summarizeDailyModelUsage(stats).map((row) => row.providerId)).toEqual(['deepseek', 'codex'])
  })

  it('ranks days by token subtotal with newer dates breaking ties without mutating history', () => {
    const days = [
      day('2026-10-31', [model('codex', 'gpt-6-astra')]),
      day('2026-10-29', [model('opencode', 'deepseek-v4.1-flash'), model('codex', 'gpt-6.1-sol')]),
      day('2026-10-30', [model('codex', 'gpt-6.1-sol')]),
    ]
    expect(sortDailyUsageByTokens(days).map((row) => row.date)).toEqual([
      '2026-10-29', '2026-10-31', '2026-10-30',
    ])
    expect(days.map((row) => row.date)).toEqual(['2026-10-31', '2026-10-29', '2026-10-30'])
    expect(sortDailyUsageByTokens([])).toEqual([])
  })

  it.each([
    ['gpt-6.1-sol (high)', 'codex'],
    ['openai/gpt-6.1-terra', 'codex'],
    ['codex-auto-review', 'codex'],
    ['o3-mini', 'codex'],
    ['o1', 'codex'],
    ['Gemini 4 Argon (High)', 'antigravity'],
    ['google/gemini-3.8-flash', 'antigravity'],
    ['Claude Opus 4.6 (Thinking)', 'claude'],
    ['anthropic/claude-sonnet-5.5', 'claude'],
    ['Sonnet 5.5', 'claude'],
    ['Opus 5.5', 'claude'],
    ['claude-haiku-5.5', 'claude'],
    ['Claude Fable 5.1', 'claude'],
    ['deepseek-v4.1-flash-free', 'deepseek'],
    ['opencode/DEEPSEEK-v4.1-flash-free (max)', 'deepseek'],
    ['qwen3-coder', 'other'],
    ['my-gptish-model', 'other'],
    ['', 'other'],
  ])('classifies %s as %s', (name, providerId) => {
    expect(getModelProvider(name)).toBe(providerId)
  })

  it('merges a daily model across agents while preserving every token and its original cost', () => {
    const stats = day('2026-10-31', [
      model('codex', 'gpt-6.1-sol'),
      model('opencode', 'gpt-6.1-sol'),
      model('opencode', 'deepseek-v4.1-flash-free'),
      model('antigravity', 'Claude Opus 5.5'),
    ])
    const rows = summarizeDailyModelUsage(stats)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      providerId: 'codex',
      model: 'gpt-6.1-sol',
      promptCount: 4,
      inputTokens: 2_000_000,
      outputTokens: 200_000,
      cacheTokens: 1_000_000,
      totalTokens: 3_200_000,
      cost: 6.1,
    })
    expect(rows.find((r) => r.providerId === 'deepseek')?.cost).toBeCloseTo(0.4215)
    expect(rows.find((r) => r.providerId === 'claude')?.cost).toBeCloseTo(6.1)
    expect(rows.reduce((sum, r) => sum + r.cost, 0)).toBeCloseTo(calculateDailyCost(stats))
    expect(stats.models).toHaveLength(4)
    expect(stats.models[1].agentId).toBe('opencode')
  })

  it('reassigns mixed-agent history to model families and keeps date-based pricing and project totals', () => {
    const stats = project([
      day('2026-10-31', [
        model('opencode', 'gpt-6.1-terra'),
        model('codex', 'gpt-6.1-sol'),
        model('antigravity', 'Claude Opus 5.5'),
        model('opencode', 'deepseek-v4.1-flash-free'),
        model('antigravity', 'Gemini 4 Argon'),
      ]),
      day('2026-12-01', [
        model('opencode', 'Gemini 4 Argon'),
        model('claude-code', 'Claude Sonnet 5.5'),
        model('opencode', 'qwen3-coder'),
      ]),
    ])
    const rows = summarizeProjectProviderUsage(stats)
    const byProvider = Object.fromEntries(rows.map((r) => [r.providerId, r]))
    expect(Object.keys(byProvider).sort()).toEqual(['antigravity', 'claude', 'codex', 'deepseek', 'other'])
    expect(byProvider.codex.cost).toBeCloseTo(4.575)
    expect(byProvider.claude.cost).toBeCloseTo(9.15)
    expect(byProvider.antigravity.cost).toBeCloseTo(9.15)
    expect(byProvider.deepseek.cost).toBeCloseTo(0.4215)
    expect(byProvider.other.promptCount).toBe(2)
    expect(rows.reduce((sum, r) => sum + r.promptCount, 0)).toBe(stats.totalPrompts)
    expect(rows.reduce((sum, r) => sum + r.inputTokens, 0)).toBe(stats.totalInputTokens)
    expect(rows.reduce((sum, r) => sum + r.outputTokens, 0)).toBe(stats.totalOutputTokens)
    expect(rows.reduce((sum, r) => sum + r.cacheTokens, 0)).toBe(stats.totalCacheTokens)
    expect(rows.reduce((sum, r) => sum + r.totalTokens, 0)).toBe(stats.totalTokens)
    expect(rows.reduce((sum, r) => sum + r.cost, 0)).toBeCloseTo(calculateProjectCost(stats))
  })

  it('handles projects without usage', () => {
    expect(summarizeDailyModelUsage(day('2026-10-31', []))).toEqual([])
    expect(summarizeProjectProviderUsage(project([]))).toEqual([])
  })

  it('removes the legacy DeepSeek free suffix and merges it with the canonical model', () => {
    const stats = day('2026-10-31', [
      model('opencode', 'deepseek-v4.1-flash-free'),
      model('opencode', 'deepseek-v4.1-flash'),
    ])
    const rows = summarizeDailyModelUsage(stats)
    expect(rows).toHaveLength(1)
    expect(rows[0].model).toBe('deepseek-v4.1-flash')
    expect(rows[0].promptCount).toBe(4)
    expect(rows[0].totalTokens).toBe(stats.totalTokens)
    expect(rows[0].cost).toBeCloseTo(calculateDailyCost(stats))
    expect(stats.models[0].model).toBe('deepseek-v4.1-flash-free')
  })

  it('keeps reasoning suffixes while hiding only the DeepSeek free suffix', () => {
    const rows = summarizeDailyModelUsage(day('2026-10-31', [
      model('opencode', 'deepseek-v4.1-flash-free (max)'),
      model('opencode', 'another-model-free'),
    ]))
    expect(rows.map((row) => row.model)).toEqual([
      'deepseek-v4.1-flash (max)',
      'another-model-free',
    ])
  })
})
