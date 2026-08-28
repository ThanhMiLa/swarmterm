// OSC 52 ("ESC ] 52 ; Pc ; Pd BEL") is the escape nvim `"+y`, tmux
// `set-clipboard`, yazi and gh use to copy from inside a terminal. This module
// is the pure policy layer; terminal-registry wires it to the clipboard.
//
// WRITE-ONLY by policy. A `?` payload is a READ request: answering it would
// type the user's clipboard into whatever program asked, in whatever pane —
// so it is refused, never echoed. An EMPTY payload is refused too: honouring
// it would let any program in any pane wipe the clipboard. UTF-8 decoding is
// fatal because a half-yank (a program that cut its buffer mid-codepoint)
// must be dropped, not landed as U+FFFD mojibake the user then pastes.
//
// The 1 MiB cap is Swarmterm's clipboard policy, enforced on the base64
// length BEFORE any decode so an oversized payload costs nothing. (xterm's
// own 10 MB OSC `PAYLOAD_LIMIT` is upstream of us and truncates the string
// before we see it.) A base64 length cap admits up to 2 bytes over 1 MiB on
// the last quantum — irrelevant for a policy limit.

export type Osc52IgnoreReason =
  | 'malformed'
  | 'read-request'
  | 'empty'
  | 'too-large'
  | 'bad-base64'
  | 'bad-utf8'

export type Osc52Result =
  | { kind: 'write'; text: string }
  | { kind: 'ignore'; reason: Osc52IgnoreReason }

export const OSC52_MAX_BYTES = 1024 * 1024
export const OSC52_MAX_BASE64_LENGTH = Math.ceil(OSC52_MAX_BYTES / 3) * 4

// Strict shape check before atob: atob is lenient about some garbage on some
// engines, and over-padding ("aGk==") must be rejected consistently.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

const utf8 = new TextDecoder('utf-8', { fatal: true })

export function parseOsc52(data: string): Osc52Result {
  // base64 never contains ';', so the FIRST ';' is the Pc/Pd boundary. Pc
  // (c/p/s/0-7 selection names) is discarded on purpose — Swarmterm has one
  // clipboard, and tmux emits an empty Pc ("52;;…").
  const sep = data.indexOf(';')
  if (sep < 0) return { kind: 'ignore', reason: 'malformed' }

  // Line-wrapping encoders (`base64` without -w0) leave whitespace inside
  // the payload; strip it before every check so "?" and "" are seen as such.
  const payload = data.slice(sep + 1).replace(/[ \t\r\n\f\v]/g, '')

  if (payload.startsWith('?')) return { kind: 'ignore', reason: 'read-request' }
  if (payload === '') return { kind: 'ignore', reason: 'empty' }
  if (payload.length > OSC52_MAX_BASE64_LENGTH) return { kind: 'ignore', reason: 'too-large' }

  if (!BASE64.test(payload)) return { kind: 'ignore', reason: 'bad-base64' }
  let bin: string
  try {
    bin = atob(payload)
  } catch {
    return { kind: 'ignore', reason: 'bad-base64' }
  }

  try {
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    // Verbatim — never trimmed: a yanked line keeps its trailing newline.
    return { kind: 'write', text: utf8.decode(bytes) }
  } catch {
    return { kind: 'ignore', reason: 'bad-utf8' }
  }
}
