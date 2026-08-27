import type { DisplayState } from '@/lib/agent-state/types'

/**
 * Age of an agent state, for tooltips and the attention ring. Thresholds
 * match `sessionTimeLabel` (agent-sessions.ts) so the two relative times in
 * the app agree, but the wording differs on purpose: a dot is "blocked FOR
 * 4m" (still true now), a session was updated "4m AGO" (a past event).
 * Clock skew and a stamp from the future clamp to "<1m" — never negative.
 */
export function formatStateAge(sinceMs: number, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - sinceMs) / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** Tooltip text for a per-pane dot. The tail is StateDot's static label so a
 *  dot with and without an age reads the same. `done` ages from the finish,
 *  not from when the user last looked — that is what "ago" refers to. */
export function stateAgeTitle(dot: 'blocked' | 'done' | 'working', sinceMs: number, nowMs: number): string {
  const age = formatStateAge(sinceMs, nowMs)
  switch (dot) {
    case 'blocked':
      return `Blocked for ${age} — needs your input`
    case 'done':
      return `Done ${age} ago — finished while you were away`
    case 'working':
      return `Working for ${age}`
  }
}

/** Sort comparator: the pane that entered its state earliest comes first;
 *  panes with no stamp (plain shells) sink to the end; ties are 0 so callers
 *  can chain `|| a.index - b.index` for a deterministic visual fallback. */
export function compareWait(a: number | undefined, b: number | undefined): number {
  if (a === undefined) return b === undefined ? 0 : 1
  if (b === undefined) return -1
  return a - b
}

/** Longest age among panes currently in `display`, or undefined when none
 *  qualifies — feeds the header pill's "(longest 4m)". */
export function longestWaitMs(
  panes: ReadonlyArray<{ display: DisplayState | undefined; sinceMs?: number }>,
  display: DisplayState,
  nowMs: number
): number | undefined {
  let longest: number | undefined
  for (const p of panes) {
    if (p.display !== display || p.sinceMs === undefined) continue
    const age = Math.max(0, nowMs - p.sinceMs)
    if (longest === undefined || age > longest) longest = age
  }
  return longest
}
