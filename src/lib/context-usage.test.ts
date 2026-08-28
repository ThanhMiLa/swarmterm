import { describe, expect, it } from 'vitest'
import {
  CTX_DANGER_PCT,
  CTX_WARN_PCT,
  NO_CHANGE,
  applyContextSample,
  contextBand,
  contextUsageTitle,
  formatContextUsage
} from './context-usage'

describe('contextBand', () => {
  it('mirrors render.rs::ctx_color thresholds (70 warn, 90 danger)', () => {
    expect(CTX_WARN_PCT).toBe(70)
    expect(CTX_DANGER_PCT).toBe(90)
    expect(contextBand(0)).toBe('normal')
    expect(contextBand(69)).toBe('normal')
    expect(contextBand(70)).toBe('warn')
    expect(contextBand(89)).toBe('warn')
    expect(contextBand(90)).toBe('danger')
    expect(contextBand(100)).toBe('danger')
  })
})

describe('formatContextUsage / contextUsageTitle', () => {
  it('renders the chip label and its tooltip', () => {
    expect(formatContextUsage(63)).toBe('ctx 63%')
    expect(formatContextUsage(0)).toBe('ctx 0%')
    expect(contextUsageTitle(63)).toBe("Context window 63% used — from Claude Code's status line")
  })
})

describe('applyContextSample', () => {
  it('first sample is a change, zero included', () => {
    expect(applyContextSample(undefined, 63)).toBe(63)
    expect(applyContextSample(undefined, 0)).toBe(0)
  })

  it('same rounded value is NO_CHANGE, a different one replaces it', () => {
    expect(applyContextSample(63, 63)).toBe(NO_CHANGE)
    expect(applyContextSample(63, 63.4)).toBe(NO_CHANGE)
    expect(applyContextSample(63, 63.6)).toBe(64)
  })

  it('has no monotone hold — a drop is the compaction the user wants to see', () => {
    expect(applyContextSample(63, 41)).toBe(41)
  })

  it('null clears a shown value once and is NO_CHANGE when nothing is shown', () => {
    expect(applyContextSample(63, null)).toBeUndefined()
    expect(applyContextSample(undefined, null)).toBe(NO_CHANGE)
  })

  it('never paints garbage: non-finite or out-of-range samples are NO_CHANGE', () => {
    expect(applyContextSample(63, Number.NaN)).toBe(NO_CHANGE)
    expect(applyContextSample(63, Number.POSITIVE_INFINITY)).toBe(NO_CHANGE)
    expect(applyContextSample(63, 101)).toBe(NO_CHANGE)
    expect(applyContextSample(63, -1)).toBe(NO_CHANGE)
    expect(applyContextSample(undefined, 101)).toBe(NO_CHANGE)
  })
})
