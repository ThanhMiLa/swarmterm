/**
 * Neutralise terminal control bytes in a War Room body before it is written to
 * a pty. A body carrying `\x1b[201~` would close the bracketed paste early and
 * everything after it would be parsed as live keystrokes / escape sequences by
 * the recipient TUI (paste-injection). ESC becomes the readable literal
 * `<ESC>` so the agent still sees what was meant; every other C0 control, DEL
 * and C1 (U+0080–U+009F — U+009B is a one-byte CSI for some parsers) is
 * dropped. Tab/LF/CR stay: they are legitimate prompt structure and the
 * delivery path normalises line breaks itself. Never trims, never touches
 * printable Unicode, and is idempotent (`<ESC>` contains no control char).
 */
export function sanitizePromptText(text: string): string {
  return text
    .replace(/\x1b/g, '<ESC>')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g, '')
}
