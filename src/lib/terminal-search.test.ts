import { describe, expect, it } from 'vitest'
import { matchSummary, validateSearchQuery } from '@/lib/terminal-search'

describe('validateSearchQuery', () => {
  it('accepts the empty query even in regex mode — empty means clear, never compile', () => {
    expect(validateSearchQuery('', false)).toBeNull()
    expect(validateSearchQuery('', true)).toBeNull()
  })

  it('never rejects anything with regex off — the addon escapes literal text itself', () => {
    for (const q of ['foo(', '[', 'a\\', '(?<', '*']) {
      expect(validateSearchQuery(q, false)).toBeNull()
    }
  })

  it('rejects what RegExp() would throw on with regex on', () => {
    for (const q of ['foo(', '[', 'a\\', '(?<', '*']) {
      expect(validateSearchQuery(q, true)).toBe('invalid-regex')
    }
  })

  it('accepts well-formed patterns with regex on', () => {
    for (const q of ['fo+', '^\\d+$', 'a|b', '\\(', '.*', '[a-z]{2,}']) {
      expect(validateSearchQuery(q, true)).toBeNull()
    }
  })

  it('validates without the u/v flags so patterns the addon compiles under g/gi stay accepted', () => {
    // Identity escape `\-` and a lone `}` are SyntaxErrors under `u` but fine
    // under plain `g` — the only flag family the addon uses.
    expect(validateSearchQuery('\\-', true)).toBeNull()
    expect(validateSearchQuery('}', true)).toBeNull()
  })
})

describe('matchSummary', () => {
  it('is blank for the empty query regardless of counts or error', () => {
    expect(matchSummary('', -1, 0)).toBe('')
    expect(matchSummary('', 2, 5)).toBe('')
    expect(matchSummary('', -1, 0, 'invalid-regex')).toBe('')
  })

  it('reads "No results" at zero', () => {
    expect(matchSummary('x', -1, 0)).toBe('No results')
  })

  it('shows the bare total when the addon reports index -1 past its highlight cap', () => {
    expect(matchSummary('x', -1, 1200)).toBe('1200 results')
  })

  it('is 1-based "k of n"', () => {
    expect(matchSummary('x', 0, 3)).toBe('1 of 3')
    expect(matchSummary('x', 2, 3)).toBe('3 of 3')
  })

  it('error wins over any counts; null/undefined error falls through', () => {
    expect(matchSummary('foo(', -1, 0, 'invalid-regex')).toBe('Invalid regex')
    expect(matchSummary('foo(', 2, 9, 'invalid-regex')).toBe('Invalid regex')
    expect(matchSummary('foo(', 2, 9, null)).toBe('3 of 9')
    expect(matchSummary('foo(', 2, 9, undefined)).toBe('3 of 9')
  })
})
