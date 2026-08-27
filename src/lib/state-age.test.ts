import { describe, expect, it } from 'vitest'
import { compareWait, formatStateAge, longestWaitMs, stateAgeTitle } from '@/lib/state-age'

const M = 60_000
const H = 60 * M
const D = 24 * H

describe('formatStateAge', () => {
  it('uses the same coarse thresholds as sessionTimeLabel, without "ago"', () => {
    expect(formatStateAge(0, 30_000)).toBe('<1m')
    expect(formatStateAge(0, 4 * M)).toBe('4m')
    expect(formatStateAge(0, 59 * M + 59_000)).toBe('59m')
    expect(formatStateAge(0, 3 * H)).toBe('3h')
    expect(formatStateAge(0, 23 * H + 59 * M)).toBe('23h')
    expect(formatStateAge(0, 2 * D)).toBe('2d')
  })

  it('clamps clock skew (now before since) to "<1m"', () => {
    expect(formatStateAge(10 * M, 0)).toBe('<1m')
  })
})

describe('stateAgeTitle', () => {
  it('keeps StateDot label wording as the tail', () => {
    expect(stateAgeTitle('blocked', 0, 4 * M)).toBe('Blocked for 4m — needs your input')
    expect(stateAgeTitle('done', 0, 4 * M)).toBe('Done 4m ago — finished while you were away')
    expect(stateAgeTitle('working', 0, 4 * M)).toBe('Working for 4m')
  })

  it('reads naturally under a minute', () => {
    expect(stateAgeTitle('blocked', 0, 5_000)).toBe('Blocked for <1m — needs your input')
    expect(stateAgeTitle('done', 0, 5_000)).toBe('Done <1m ago — finished while you were away')
  })
})

describe('compareWait', () => {
  it('sorts the older stamp first', () => {
    expect(compareWait(100, 900)).toBeLessThan(0)
    expect(compareWait(900, 100)).toBeGreaterThan(0)
  })

  it('ties are 0 so the caller can fall through to visual order', () => {
    expect(compareWait(5, 5)).toBe(0)
    expect(compareWait(undefined, undefined)).toBe(0)
  })

  it('puts undefined (no stamp) last', () => {
    expect(compareWait(undefined, 100)).toBeGreaterThan(0)
    expect(compareWait(100, undefined)).toBeLessThan(0)
  })

  it('is usable directly as an Array.sort comparator', () => {
    expect([900, undefined, 100, 500].sort(compareWait)).toEqual([100, 500, 900, undefined])
  })
})

describe('longestWaitMs', () => {
  const panes = [
    { display: 'blocked' as const, sinceMs: 1_000 },
    { display: 'blocked' as const, sinceMs: 7_000 },
    { display: 'done' as const, sinceMs: 100 },
    { display: 'working' as const, sinceMs: 0 },
    { display: undefined, sinceMs: undefined }
  ]

  it('returns the largest age among panes in the requested display state', () => {
    expect(longestWaitMs(panes, 'blocked', 10_000)).toBe(9_000)
    expect(longestWaitMs(panes, 'done', 10_000)).toBe(9_900)
  })

  it('is undefined when no pane is in that state', () => {
    expect(longestWaitMs(panes, 'idle', 10_000)).toBeUndefined()
    expect(longestWaitMs([], 'blocked', 10_000)).toBeUndefined()
  })

  it('ignores panes without a stamp and clamps skew to 0', () => {
    expect(longestWaitMs([{ display: 'blocked', sinceMs: undefined }], 'blocked', 10_000)).toBeUndefined()
    expect(longestWaitMs([{ display: 'blocked', sinceMs: 20_000 }], 'blocked', 10_000)).toBe(0)
  })
})
