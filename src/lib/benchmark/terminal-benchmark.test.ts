import { describe, it, expect } from 'vitest'
import {
  generateStaticLog,
  generateStreamChunks,
  generateWheelReplaySequence
} from './fixtures'
import { computeStats } from './terminal-benchmark'

describe('terminal-benchmark fixtures and stats', () => {
  it('generates non-empty static log with ANSI sequences', () => {
    const log = generateStaticLog(100)
    expect(log.length).toBeGreaterThan(0)
    expect(log).toContain('INFO')
    expect(log.split('\r\n').length).toBeGreaterThanOrEqual(100)
  })

  it('generates stream chunks of specified size', () => {
    const chunks = generateStreamChunks(10, 512)
    expect(chunks.length).toBe(10)
    expect(chunks[0].length).toBe(512)
  })

  it('generates repeatable wheel replay sequences', () => {
    const flick = generateWheelReplaySequence('trackpad-flick')
    expect(flick.length).toBeGreaterThan(0)
    expect(flick[0].deltaMode).toBe(0) // pixel mode

    const slow = generateWheelReplaySequence('trackpad-slow')
    expect(slow.every((s) => s.deltaY === 15)).toBe(true)

    const mouse = generateWheelReplaySequence('mouse-wheel')
    expect(mouse[0].deltaMode).toBe(1) // line mode
  })

  it('computes latency percentiles correctly', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    const stats = computeStats(samples)
    expect(stats.count).toBe(10)
    expect(stats.minMs).toBe(10)
    expect(stats.maxMs).toBe(100)
    expect(stats.meanMs).toBe(55)
    expect(stats.p50Ms).toBe(60)
    expect(stats.p95Ms).toBe(100)
  })
})
