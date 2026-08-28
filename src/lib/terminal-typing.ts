/**
 * Classifies one `onData` payload from xterm — one piece of genuine user
 * input — so the War Room nudge guard can tell "mid-line" from "line
 * finished". Pure; the store applies the result and the delivery scheduler
 * reads it. See `shouldDeferDelivery` in war-room-nudge.ts.
 */
export type InputKind = 'edit' | 'submit' | 'nav'

/** Lone control codes that commit or abandon the current line. `\x1b` here is
 *  Esc pressed on its own — an escape SEQUENCE starts with the same byte and
 *  is handled below, which is the one distinction this module exists for. */
const LINE_ENDING_CODES = new Set(['\r', '\n', '\x03', '\x15', '\x1b'])

/** The frame xterm's `paste()` emits when the foreground app has enabled
 *  bracketed paste (DECSET 2004) — every agent TUI does, and so do zsh/bash by
 *  default. xterm hands the WHOLE clipboard over as ONE `onData` payload with
 *  `\n` already normalised to `\r`, so a frame never straddles two calls and
 *  this stays stateless. Strict on BOTH markers: a payload that merely starts
 *  with the opener is an ordinary escape sequence, not a paste. */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

export function isBracketedPaste(data: string): boolean {
  return data.startsWith(PASTE_START) && data.endsWith(PASTE_END)
}

export function classifyInput(data: string): InputKind {
  if (data === '') return 'nav'
  // Bracketed paste is the one ESC-prefixed payload that CHANGES the line, and
  // the CRs inside the frame are inert — not executing them is the entire
  // point of the mode. Without this arm a pasted `deploy prod` reads as
  // navigation (dirty never set) and a two-line paste reads as a submit
  // (dirty CLEARED) while the text is still sitting unsent on the line, so a
  // War Room nudge would be typed over it. The inner text is irrelevant: the
  // app inserts it literally, which is by definition an unsubmitted line. An
  // empty frame cannot occur (the Ctrl/Cmd+V path gates on non-empty text)
  // and over-holding is this module's safe direction, so it is `edit` too.
  if (isBracketedPaste(data)) return 'edit'
  if (LINE_ENDING_CODES.has(data)) return 'submit'
  // A CR/LF anywhere means at least one line was committed — an UNFRAMED
  // multi-line paste (bracketed paste off — the shell really runs each line),
  // or a chord whose payload ends in Enter.
  if (data.includes('\r') || data.includes('\n')) return 'submit'
  // Arrows, Home/End, function keys: they move the cursor without changing
  // what is on the line, so they refresh the "recently active" timestamp but
  // must not clear the dirty flag.
  if (data.startsWith('\x1b')) return 'nav'
  // Everything else edits the line, backspace included. Backspacing a line
  // down to empty still counts as dirty — we cannot see the line's contents,
  // and over-holding a delivery is the safe direction to err in. Esc clears it.
  return 'edit'
}
