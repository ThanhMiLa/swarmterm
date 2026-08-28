/**
 * Context-window usage (`agent:context`) → the pane-header chip.
 *
 * Why this exists: the chip mirrors the number Claude Code's OWN status line
 * prints inside the pane (`swarmterm --statusline` reads `used_percentage` from
 * the stdin payload and carries it on the 300 ms `/status` probe, see
 * `src-tauri/src/statusline/probe.rs` + `mcp/context_usage.rs`). Two renderers
 * of one number must agree on every turn: if the in-pane line turns amber at
 * 70 % and the chip only at 75 %, the user sees two verdicts for the same
 * value and trusts neither. So the bands here are LOCKSTEP with
 * `render.rs::ctx_color` — change one, change both (the test pins 70/90).
 *
 * Rust already rounds to an integer, filters non-finite / out-of-range samples
 * and emits only on change, so most of `applyContextSample` is belt-and-braces.
 * The one rule only the renderer can decide is "is anything shown right now?":
 * Rust publishes `pct: null` on EVERY Forget (SessionStart/SessionEnd hooks,
 * kill, read_loop EOF), so an idle pane that never showed a chip receives nulls
 * it must ignore without churning its store subscribers.
 *
 * Deliberately NO monotone hold: a drop in the percentage IS the compaction the
 * user is waiting to see. Holding the high-water mark would hide the one event
 * this chip is for.
 */

/** Lockstep with `render.rs::ctx_color` — amber from here. */
export const CTX_WARN_PCT = 70
/** Lockstep with `render.rs::ctx_color` — red from here. */
export const CTX_DANGER_PCT = 90

export type ContextBand = 'normal' | 'warn' | 'danger'

export function contextBand(pct: number): ContextBand {
  if (pct >= CTX_DANGER_PCT) return 'danger'
  if (pct >= CTX_WARN_PCT) return 'warn'
  return 'normal'
}

/** Chip label. Short on purpose — it rides the folder-path threshold in narrow headers. */
export function formatContextUsage(pct: number): string {
  return `ctx ${pct}%`
}

/** Tooltip — names the source so a user who turned the status line off knows why the chip vanished. */
export function contextUsageTitle(pct: number): string {
  return `Context window ${pct}% used — from Claude Code's status line`
}

/**
 * Sentinel for "the store must not produce a new state". A unique symbol (not
 * `undefined`) because `undefined` already means "cleared — drop the key".
 */
export const NO_CHANGE = Symbol('no-change')

/**
 * Fold one `agent:context` sample into the currently shown value.
 *
 * - `null` clears a shown value; on nothing shown it is a no-op (see module doc).
 * - Non-finite or outside `0..=100` ⇒ no-op: never paint garbage, even if a
 *   future transport stops filtering.
 * - Same ROUNDED integer ⇒ no-op, so a 63.4 after a 63 does not wake the pane.
 * - Otherwise the rounded value — `0` is data, not "nothing".
 */
export function applyContextSample(
  prev: number | undefined,
  pct: number | null
): number | undefined | typeof NO_CHANGE {
  if (pct === null) return prev === undefined ? NO_CHANGE : undefined
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return NO_CHANGE
  const next = Math.round(pct)
  return next === prev ? NO_CHANGE : next
}
