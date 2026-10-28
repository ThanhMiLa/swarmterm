import { describe, expect, it } from 'vitest'
import {
  calculateDailyAgentCosts,
  calculateDailyCost,
  calculateModelUsageCost,
  calculateProjectAgentCosts,
  calculateProjectCost,
  calculateTokenCost,
  formatCurrency,
  getModelPricing,
  normalizeModelName,
} from './token-pricing'

describe('token-pricing', () => {
  describe('normalizeModelName', () => {
    it('strips parentheses reasoning effort', () => {
      expect(normalizeModelName('gpt-6.1-sol (high)')).toBe('gpt-6.1-sol')
      expect(normalizeModelName('gpt-5.6-terra (xhigh)')).toBe('gpt-5.6-terra')
      expect(normalizeModelName('Gemini 3.8 Flash (High)')).toBe('gemini 3.8 flash')
      expect(normalizeModelName('Claude Sonnet 5.5 (Medium)')).toBe('claude sonnet 5.5')
      expect(normalizeModelName('codex-auto-review (low)')).toBe('codex-auto-review')
    })

    it('handles empty or blank names', () => {
      expect(normalizeModelName('')).toBe('')
      expect(normalizeModelName('   ')).toBe('')
    })
  })

  describe('getModelPricing for Codex (OpenAI)', () => {
    it('matches gpt-6-astra', () => {
      const p = getModelPricing('gpt-6-astra (high)')
      expect(p.inputPerMillion).toBe(10.0)
      expect(p.outputPerMillion).toBe(50.0)
      expect(p.cachePerMillion).toBe(1.0)
    })

    it('matches gpt-6.1-sol', () => {
      const p = getModelPricing('gpt-6.1-sol (ultra)')
      expect(p.inputPerMillion).toBe(2.0)
      expect(p.outputPerMillion).toBe(10.0)
      expect(p.cachePerMillion).toBe(0.1)
    })

    it('matches gpt-6.1-terra', () => {
      const p = getModelPricing('gpt-6.1-terra (high)')
      expect(p.inputPerMillion).toBe(1.0)
      expect(p.outputPerMillion).toBe(5.0)
      expect(p.cachePerMillion).toBe(0.05)
    })

    it('matches gpt-6-sol', () => {
      const p = getModelPricing('gpt-6-sol (medium)')
      expect(p.inputPerMillion).toBe(2.0)
      expect(p.outputPerMillion).toBe(10.0)
      expect(p.cachePerMillion).toBe(0.2)
    })

    it('matches gpt-6-luna', () => {
      const p = getModelPricing('gpt-6-luna (low)')
      expect(p.inputPerMillion).toBe(0.1)
      expect(p.outputPerMillion).toBe(0.5)
      expect(p.cachePerMillion).toBe(0.01)
    })

    it('matches gpt-5.6-sol', () => {
      const p = getModelPricing('gpt-5.6-sol (high)')
      expect(p.inputPerMillion).toBe(4.0)
      expect(p.outputPerMillion).toBe(20.0)
      expect(p.cachePerMillion).toBe(0.4)
    })

    it('matches gpt-5.6-terra', () => {
      const p = getModelPricing('gpt-5.6-terra (high)')
      expect(p.inputPerMillion).toBe(2.0)
      expect(p.outputPerMillion).toBe(12.0)
      expect(p.cachePerMillion).toBe(0.2)
    })

    it('matches gpt-5.6-luna', () => {
      const p = getModelPricing('gpt-5.6-luna')
      expect(p.inputPerMillion).toBe(0.2)
      expect(p.outputPerMillion).toBe(1.2)
      expect(p.cachePerMillion).toBe(0.02)
    })

    it('matches codex-auto-review', () => {
      const p = getModelPricing('codex-auto-review (low)')
      expect(p.inputPerMillion).toBe(0.1)
      expect(p.outputPerMillion).toBe(0.5)
      expect(p.cachePerMillion).toBe(0.01)
    })
  })

  describe('getModelPricing for DeepSeek', () => {
    it('matches DeepSeek V4.1 Flash', () => {
      const p = getModelPricing('DeepSeek V4.1 Flash (High)')
      expect(p.inputPerMillion).toBe(0.3)
      expect(p.outputPerMillion).toBe(1.2)
      expect(p.cachePerMillion).toBe(0.003)
    })

    it('matches the hyphenated model id', () => {
      const p = getModelPricing('deepseek-v4.1-flash')
      expect(p.inputPerMillion).toBe(0.3)
      expect(p.outputPerMillion).toBe(1.2)
      expect(p.cachePerMillion).toBe(0.003)
    })

    it('matches the OpenCode free variant id', () => {
      const p = getModelPricing('deepseek-v4.1-flash-free (max)')
      expect(p.inputPerMillion).toBe(0.3)
      expect(p.outputPerMillion).toBe(1.2)
      expect(p.cachePerMillion).toBe(0.003)
    })
  })

  describe('getModelPricing for Antigravity (Google Gemini)', () => {
    it('applies promo rate for Gemini 4 Argon before or on 2026-11-30', () => {
      const p = getModelPricing('Gemini 4 Argon (High)', '2026-10-26')
      expect(p.inputPerMillion).toBe(2.0)
      expect(p.outputPerMillion).toBe(10.0)
      expect(p.cachePerMillion).toBe(0.1)
    })

    it('applies standard rate for Gemini 4 Argon after 2026-11-30', () => {
      const p = getModelPricing('Gemini 4 Argon (High)', '2026-12-01')
      expect(p.inputPerMillion).toBe(4.0)
      expect(p.outputPerMillion).toBe(20.0)
      expect(p.cachePerMillion).toBe(0.2)
    })

    it('applies promo rate for Gemini 3.8 Flash before or on 2026-12-31', () => {
      const p = getModelPricing('Gemini 3.8 Flash (High)', '2026-10-26')
      expect(p.inputPerMillion).toBe(0.75)
      expect(p.outputPerMillion).toBe(3.75)
      expect(p.cachePerMillion).toBe(0.075)
    })

    it('applies standard rate for Gemini 3.8 Flash after 2026-12-31', () => {
      const p = getModelPricing('Gemini 3.8 Flash (High)', '2027-01-01')
      expect(p.inputPerMillion).toBe(1.5)
      expect(p.outputPerMillion).toBe(7.5)
      expect(p.cachePerMillion).toBe(0.15)
    })
  })

  describe('getModelPricing for Anthropic', () => {
    it('matches Claude Opus 5.5', () => {
      const p = getModelPricing('Claude Opus 5.5 (High)')
      expect(p.inputPerMillion).toBe(4.0)
      expect(p.outputPerMillion).toBe(20.0)
      expect(p.cachePerMillion).toBe(0.2)
    })

    it('matches Claude Sonnet 5.5', () => {
      const p = getModelPricing('Claude Sonnet 5.5 (High)')
      expect(p.inputPerMillion).toBe(2.0)
      expect(p.outputPerMillion).toBe(10.0)
      expect(p.cachePerMillion).toBe(0.1)
    })

    it('matches Claude Fable 5.1', () => {
      const p = getModelPricing('Claude Fable 5.1')
      expect(p.inputPerMillion).toBe(10.0)
      expect(p.outputPerMillion).toBe(50.0)
      expect(p.cachePerMillion).toBe(0.25)
    })

    it('matches Claude Haiku 5.5', () => {
      const p = getModelPricing('Claude Haiku 5.5')
      expect(p.inputPerMillion).toBe(0.1)
      expect(p.outputPerMillion).toBe(0.5)
      expect(p.cachePerMillion).toBe(0.01)
    })
  })

  describe('calculateTokenCost', () => {
    it('computes exact cost for gpt-6.1-sol turn', () => {
      const cost = calculateTokenCost('gpt-6.1-sol (high)', 382, 159, 90624)
      expect(cost).toBeCloseTo(0.0114164, 6)
    })

    it('computes exact cost for Gemini 3.8 Flash turn', () => {
      const cost = calculateTokenCost('Gemini 3.8 Flash (High)', 32432, 2155, 97022, '2026-10-17')
      expect(cost).toBeCloseTo(0.0396819, 6)
    })

    it('computes exact cost for gpt-6.1-terra turn', () => {
      const cost = calculateTokenCost('gpt-6.1-terra (high)', 1_000_000, 100_000, 500_000)
      // 1.00 input + 0.50 output + 0.025 cache
      expect(cost).toBeCloseTo(1.525, 6)
    })

    it('computes exact cost for DeepSeek V4.1 Flash turn', () => {
      const cost = calculateTokenCost('DeepSeek V4.1 Flash', 1_000_000, 100_000, 500_000)
      // 0.30 input + 0.12 output + 0.0015 cache
      expect(cost).toBeCloseTo(0.4215, 6)
    })
  })

  describe('calculateModelUsageCost, calculateDailyCost, calculateProjectCost', () => {
    it('computes aggregated costs correctly', () => {
      const day = {
        date: '2026-10-26',
        models: [
          {
            agentId: 'codex',
            model: 'gpt-6.1-sol (high)',
            inputTokens: 1_000_000, // $2.00
            outputTokens: 100_000,  // $1.00
            cacheTokens: 500_000,   // $0.05
          },
          {
            agentId: 'antigravity',
            model: 'Claude Sonnet 5.5',
            inputTokens: 500_000,   // $1.00
            outputTokens: 50_000,   // $0.50
            cacheTokens: 200_000,   // $0.02
          },
        ],
      }
      const model1Cost = calculateModelUsageCost(day.models[0], day.date)
      expect(model1Cost).toBeCloseTo(3.05, 4)

      const model2Cost = calculateModelUsageCost(day.models[1], day.date)
      expect(model2Cost).toBeCloseTo(1.52, 4)

      const dailyCost = calculateDailyCost(day)
      expect(dailyCost).toBeCloseTo(4.57, 4)

      const project = { dailyStats: [day] }
      expect(calculateProjectCost(project)).toBeCloseTo(4.57, 4)

      const projectAgentCosts = calculateProjectAgentCosts(project)
      expect(projectAgentCosts['codex']).toBeCloseTo(3.05, 4)
      expect(projectAgentCosts['antigravity']).toBeCloseTo(1.52, 4)

      const dailyAgentCosts = calculateDailyAgentCosts(day)
      expect(dailyAgentCosts['codex']).toBeCloseTo(3.05, 4)
      expect(dailyAgentCosts['antigravity']).toBeCloseTo(1.52, 4)
    })
  })

  describe('formatCurrency', () => {
    it('formats zero or invalid amounts', () => {
      expect(formatCurrency(0)).toBe('$0.00')
      expect(formatCurrency(-5)).toBe('$0.00')
      expect(formatCurrency(NaN)).toBe('$0.00')
    })

    it('formats small amounts with 4 decimals', () => {
      expect(formatCurrency(0.0042)).toBe('$0.0042')
      expect(formatCurrency(0.0001)).toBe('$0.0001')
    })

    it('formats standard amounts with 2 decimals and commas', () => {
      expect(formatCurrency(1.25)).toBe('$1.25')
      expect(formatCurrency(1234.567)).toBe('$1,234.57')
      expect(formatCurrency(10.0)).toBe('$10.00')
    })
  })
})
