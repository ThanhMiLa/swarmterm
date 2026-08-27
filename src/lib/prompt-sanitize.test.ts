import { describe, expect, it } from 'vitest'
import { sanitizePromptText } from '@/lib/prompt-sanitize'

describe('sanitizePromptText', () => {
  it('leaves plain text untouched, including tab/LF/CR and trailing whitespace', () => {
    const s = 'run the tests\n\tthen report \r\n  '
    expect(sanitizePromptText(s)).toBe(s)
  })

  it('turns ESC into the inert literal <ESC> so a paste-close marker cannot fire', () => {
    expect(sanitizePromptText('ok\x1b[201~rm -rf /')).toBe('ok<ESC>[201~rm -rf /')
  })

  it('replaces every ESC, not just the first', () => {
    expect(sanitizePromptText('\x1b[31mred\x1b[0m')).toBe('<ESC>[31mred<ESC>[0m')
  })

  it('drops other C0 controls, DEL and C1 (incl. the single-char CSI U+009B)', () => {
    expect(sanitizePromptText('a\x00b\x07c\x7fd\x9be\x1ff')).toBe('abcdef')
  })

  it('keeps emoji, CJK and box-drawing intact', () => {
    const s = '🚀 日本語 ─┼─ café'
    expect(sanitizePromptText(s)).toBe(s)
  })

  it('returns the empty string for the empty string', () => {
    expect(sanitizePromptText('')).toBe('')
  })

  it('is idempotent', () => {
    const once = sanitizePromptText('x\x1b[201~\x07y')
    expect(sanitizePromptText(once)).toBe(once)
  })
})
