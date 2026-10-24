import { describe, expect, it } from 'vitest'
import type { TokenUsageResponse } from './token-usage'

describe('token-usage data structures', () => {
  it('shapes TokenUsageResponse correctly', () => {
    const mockResponse: TokenUsageResponse = {
      projects: [
        {
          projectPath: '/Users/test/my-project',
          projectName: 'my-project',
          totalPrompts: 5,
          totalInputTokens: 5000,
          totalOutputTokens: 1000,
          totalCacheTokens: 20000,
          totalTokens: 26000,
          lastPrompt: {
            turnKey: 'codex:sess-1:turn-5',
            agentId: 'codex',
            model: 'gpt-6.1-sol (high)',
            projectPath: '/Users/test/my-project',
            date: '2026-10-25',
            timestampMs: 1729815000000,
            inputTokens: 1200,
            outputTokens: 300,
            cacheTokens: 5000,
            totalTokens: 6500,
          },
          dailyStats: [
            {
              date: '2026-10-25',
              promptCount: 5,
              inputTokens: 5000,
              outputTokens: 1000,
              cacheTokens: 20000,
              totalTokens: 26000,
              models: [
                {
                  agentId: 'codex',
                  model: 'gpt-6.1-sol (high)',
                  promptCount: 5,
                  inputTokens: 5000,
                  outputTokens: 1000,
                  cacheTokens: 20000,
                  totalTokens: 26000,
                },
              ],
            },
          ],
        },
      ],
      overallLastPrompt: null,
      totalAllTokens: 26000,
    }

    expect(mockResponse.projects.length).toBe(1)
    const p = mockResponse.projects[0]
    expect(p.totalTokens).toBe(26000)
    expect(p.dailyStats[0].models[0].model).toBe('gpt-6.1-sol (high)')
    expect(p.lastPrompt?.turnKey).toBe('codex:sess-1:turn-5')
  })
})
