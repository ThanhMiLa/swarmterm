import { describe, expect, it } from 'vitest'
import { OSC52_MAX_BASE64_LENGTH, OSC52_MAX_BYTES, parseOsc52 } from './osc52'

// TextEncoder + btoa instead of Buffer: tsconfig has no @types/node (lib is
// DOM only), and the 1 MiB vector must not go through a spread call.
const b64 = (s: string) => {
  let bin = ''
  for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte)
  return btoa(bin)
}

describe('parseOsc52', () => {
  it('writes the decoded payload of a plain clipboard selection', () => {
    expect(parseOsc52('c;aGk=')).toEqual({ kind: 'write', text: 'hi' })
  })

  it('accepts an empty selection parameter (tmux emits "52;;…")', () => {
    expect(parseOsc52(';aGk=')).toEqual({ kind: 'write', text: 'hi' })
  })

  it('ignores the selection parameter beyond the split — p/s/digits all map to the one clipboard', () => {
    expect(parseOsc52('ps0;aGk=')).toEqual({ kind: 'write', text: 'hi' })
  })

  it('refuses a read request so a pane program can never pull the clipboard into a pty', () => {
    expect(parseOsc52('c;?')).toEqual({ kind: 'ignore', reason: 'read-request' })
    expect(parseOsc52('c;?aGk=')).toEqual({ kind: 'ignore', reason: 'read-request' })
  })

  it('refuses an empty payload instead of erasing the clipboard', () => {
    expect(parseOsc52('c;')).toEqual({ kind: 'ignore', reason: 'empty' })
    expect(parseOsc52('c; \t')).toEqual({ kind: 'ignore', reason: 'empty' })
  })

  it('treats a sequence without ";" as malformed', () => {
    expect(parseOsc52('aGk=')).toEqual({ kind: 'ignore', reason: 'malformed' })
    expect(parseOsc52('')).toEqual({ kind: 'ignore', reason: 'malformed' })
  })

  it('accepts unpadded base64', () => {
    expect(parseOsc52('c;aGk')).toEqual({ kind: 'write', text: 'hi' })
  })

  it('strips ASCII whitespace inside the payload (line-wrapping encoders)', () => {
    expect(parseOsc52('c;a Gk\r\n=')).toEqual({ kind: 'write', text: 'hi' })
  })

  it('rejects invalid base64', () => {
    expect(parseOsc52('c;@@@')).toEqual({ kind: 'ignore', reason: 'bad-base64' })
    expect(parseOsc52('c;a')).toEqual({ kind: 'ignore', reason: 'bad-base64' })
    expect(parseOsc52('c;aGk==')).toEqual({ kind: 'ignore', reason: 'bad-base64' })
  })

  it('rejects bytes that are not valid UTF-8 rather than writing U+FFFD mojibake', () => {
    expect(parseOsc52('c;/w==')).toEqual({ kind: 'ignore', reason: 'bad-utf8' })
  })

  it('round-trips emoji, CJK and box drawing verbatim, keeping newlines untrimmed', () => {
    const s = 'héllo 🚀 ┌─┐ 日本\nline2\n'
    expect(parseOsc52(`c;${b64(s)}`)).toEqual({ kind: 'write', text: s })
  })

  it('refuses a payload above the cap BEFORE decoding it (too-large, not bad-base64)', () => {
    expect(OSC52_MAX_BYTES).toBe(1024 * 1024)
    expect(OSC52_MAX_BASE64_LENGTH).toBe(1_398_104)
    expect(parseOsc52(`c;${'A'.repeat(OSC52_MAX_BASE64_LENGTH + 1)}`)).toEqual({
      kind: 'ignore',
      reason: 'too-large',
    })
  })

  it('decodes a payload of exactly 1 MiB', () => {
    const payload = b64('a'.repeat(OSC52_MAX_BYTES))
    expect(payload.length).toBe(OSC52_MAX_BASE64_LENGTH)
    const r = parseOsc52(`c;${payload}`)
    expect(r.kind).toBe('write')
    if (r.kind === 'write') expect(r.text.length).toBe(OSC52_MAX_BYTES)
  })
})
