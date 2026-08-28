import { describe, expect, it } from 'vitest'
import { classifyInput, isBracketedPaste } from './terminal-typing'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
/** The exact frame xterm's `paste()` emits when the app enabled bracketed paste. */
const paste = (inner: string) => `${PASTE_START}${inner}${PASTE_END}`

describe('classifyInput', () => {
  it('treats printable characters and backspace as editing', () => {
    expect(classifyInput('a')).toBe('edit')
    expect(classifyInput('hello')).toBe('edit')
    expect(classifyInput('\x7f')).toBe('edit') // backspace
    expect(classifyInput('  ')).toBe('edit')
  })

  it('treats a multi-character IME commit as editing', () => {
    expect(classifyInput('xin chào')).toBe('edit')
    expect(classifyInput('日本語')).toBe('edit')
  })

  it('treats Enter, Ctrl+C, Ctrl+U and a bare Esc as ending the line', () => {
    expect(classifyInput('\r')).toBe('submit')
    expect(classifyInput('\n')).toBe('submit')
    expect(classifyInput('\x03')).toBe('submit')
    expect(classifyInput('\x15')).toBe('submit')
    expect(classifyInput('\x1b')).toBe('submit')
  })

  it('treats any payload containing a newline as ending the line', () => {
    expect(classifyInput('do the thing\r')).toBe('submit')
    expect(classifyInput('line one\nline two')).toBe('submit')
  })

  it('treats escape SEQUENCES as navigation, not as Esc', () => {
    // This is the whole point of the module: \x1b is Esc, \x1b[ starts a
    // sequence. Getting it wrong makes every arrow key clear the dirty flag.
    expect(classifyInput('\x1b[A')).toBe('nav') // up
    expect(classifyInput('\x1b[D')).toBe('nav') // left
    expect(classifyInput('\x1b[H')).toBe('nav') // home
    expect(classifyInput('\x1bOP')).toBe('nav') // F1 in application mode
  })

  it('treats an empty payload as navigation (nothing was typed)', () => {
    expect(classifyInput('')).toBe('nav')
  })

  it('treats a bracketed paste as editing, whatever the frame contains', () => {
    // xterm wraps the clipboard in \x1b[200~ … \x1b[201~ whenever the foreground
    // app enabled bracketed paste (every agent TUI does) and the app inserts the
    // payload LITERALLY — the embedded CRs do not submit. Reading the frame as
    // an escape sequence (nav) or as a submit disarms the hold exactly while
    // the pasted text is still sitting unsent on the line.
    expect(classifyInput(paste('deploy prod'))).toBe('edit')
    expect(classifyInput(paste('line one\rline two'))).toBe('edit')
    expect(classifyInput(paste('line one\nline two'))).toBe('edit')
    expect(classifyInput(paste('a\r'))).toBe('edit')
    expect(classifyInput(paste('\x1b[A'))).toBe('edit')
    expect(classifyInput(paste(''))).toBe('edit')
  })

  it('keeps unframed payloads on the old rules (bracketed paste off, or half a frame)', () => {
    expect(classifyInput('a\rb')).toBe('submit')
    expect(classifyInput('\x1b[200~a\rb')).toBe('submit') // no closer ⇒ not a frame
    expect(classifyInput('\x1b[200~x')).toBe('nav') // no closer ⇒ plain escape sequence
    expect(classifyInput('\x1b[A')).toBe('nav')
    expect(classifyInput('\x1b')).toBe('submit')
  })
})

describe('isBracketedPaste', () => {
  it('matches only a frame closed on both ends', () => {
    expect(isBracketedPaste(paste('deploy prod'))).toBe(true)
    expect(isBracketedPaste(paste('line one\rline two'))).toBe(true)
    expect(isBracketedPaste(paste(''))).toBe(true)
    expect(isBracketedPaste(`${PASTE_START}x`)).toBe(false)
    expect(isBracketedPaste(`x${PASTE_END}`)).toBe(false)
    expect(isBracketedPaste(PASTE_START)).toBe(false)
    expect(isBracketedPaste(PASTE_END)).toBe(false)
    expect(isBracketedPaste('\x1b[A')).toBe(false)
    expect(isBracketedPaste('x')).toBe(false)
    expect(isBracketedPaste('')).toBe(false)
  })
})
