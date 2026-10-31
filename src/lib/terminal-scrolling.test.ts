import { describe, it, expect, beforeEach } from 'vitest'
import {
  DEFAULT_SCROLLING_PREF,
  normalizeSensitivity,
  parseStoredScrollingPref,
  readStoredScrollingPref,
  storeScrollingPref,
  effectiveScrollOptions,
  SCROLLING_STORAGE_KEY,
  type TerminalScrollingPref
} from './terminal-scrolling'

describe('terminal-scrolling preferences', () => {
  let fakeStorage: Record<string, string>
  let storageMock: Storage

  beforeEach(() => {
    fakeStorage = {}
    storageMock = {
      getItem: (key: string) => fakeStorage[key] ?? null,
      setItem: (key: string, val: string) => {
        fakeStorage[key] = val
      },
      removeItem: (key: string) => {
        delete fakeStorage[key]
      },
      clear: () => {
        fakeStorage = {}
      },
      key: () => null,
      length: 0
    }
  })

  it('provides expected defaults: enhanced mode, 1.5 sensitivity, smoothMouseWheel true', () => {
    expect(DEFAULT_SCROLLING_PREF.mode).toBe('enhanced')
    expect(DEFAULT_SCROLLING_PREF.sensitivity).toBe(1.5)
    expect(DEFAULT_SCROLLING_PREF.smoothMouseWheel).toBe(true)
  })

  it('normalizes sensitivity within 0.25 to 3.0 in 0.25 steps', () => {
    expect(normalizeSensitivity(0.1)).toBe(0.25)
    expect(normalizeSensitivity(0.25)).toBe(0.25)
    expect(normalizeSensitivity(1.23)).toBe(1.25)
    expect(normalizeSensitivity(1.5)).toBe(1.5)
    expect(normalizeSensitivity(1.61)).toBe(1.5)
    expect(normalizeSensitivity(1.64)).toBe(1.75)
    expect(normalizeSensitivity(3.5)).toBe(3.0)
    expect(normalizeSensitivity(NaN)).toBe(1.5)
  })

  it('falls back to default when raw json is empty or corrupted', () => {
    expect(parseStoredScrollingPref(null)).toEqual(DEFAULT_SCROLLING_PREF)
    expect(parseStoredScrollingPref('')).toEqual(DEFAULT_SCROLLING_PREF)
    expect(parseStoredScrollingPref('{ bad json')).toEqual(DEFAULT_SCROLLING_PREF)
    expect(parseStoredScrollingPref('123')).toEqual(DEFAULT_SCROLLING_PREF)
  })

  it('parses valid and partial configurations correctly', () => {
    const parsed = parseStoredScrollingPref(
      JSON.stringify({ mode: 'compatibility', sensitivity: 2.0, smoothMouseWheel: false })
    )
    expect(parsed.mode).toBe('compatibility')
    expect(parsed.sensitivity).toBe(2.0)
    expect(parsed.smoothMouseWheel).toBe(false)

    const partial = parseStoredScrollingPref(JSON.stringify({ sensitivity: 2.75 }))
    expect(partial.mode).toBe('enhanced')
    expect(partial.sensitivity).toBe(2.75)
    expect(partial.smoothMouseWheel).toBe(true)
  })

  it('reads and stores to localStorage', () => {
    const pref: TerminalScrollingPref = {
      mode: 'compatibility',
      sensitivity: 0.75,
      smoothMouseWheel: false
    }
    storeScrollingPref(storageMock, pref)
    expect(fakeStorage[SCROLLING_STORAGE_KEY]).toBeDefined()

    const read = readStoredScrollingPref(storageMock)
    expect(read).toEqual(pref)
  })

  it('calculates effective xterm options for enhanced vs compatibility mode', () => {
    const enhancedOpts = effectiveScrollOptions({
      mode: 'enhanced',
      sensitivity: 2.25,
      smoothMouseWheel: true
    })
    expect(enhancedOpts.mode).toBe('enhanced')
    expect(enhancedOpts.scrollSensitivity).toBe(2.25)
    expect(enhancedOpts.smoothScrollDuration).toBe(100)
    expect(enhancedOpts.enhancedWheel).toBe(true)

    const enhancedNoSmooth = effectiveScrollOptions({
      mode: 'enhanced',
      sensitivity: 1.5,
      smoothMouseWheel: false
    })
    expect(enhancedNoSmooth.scrollSensitivity).toBe(1.5)
    expect(enhancedNoSmooth.smoothScrollDuration).toBe(0)
    expect(enhancedNoSmooth.enhancedWheel).toBe(true)

    const compatOpts = effectiveScrollOptions({
      mode: 'compatibility',
      sensitivity: 2.5,
      smoothMouseWheel: true
    })
    expect(compatOpts.mode).toBe('compatibility')
    expect(compatOpts.scrollSensitivity).toBe(1.0)
    expect(compatOpts.smoothScrollDuration).toBe(0)
    expect(compatOpts.enhancedWheel).toBe(false)
  })
})
