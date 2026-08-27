import { collectLeaves, type LayoutNode } from '@/lib/layout-tree'
import { displayState, type AgentPaneState } from '@/lib/agent-state/rollup'
import type { DisplayState } from '@/lib/agent-state/types'
import { compareWait } from '@/lib/state-age'

/** One pane as the attention selector sees it. `display` is undefined for
 *  plain shells (no agent-state entry). */
export interface AttentionPane {
  terminalId: string
  display: DisplayState | undefined
  /** Entry stamp from the store; undefined only for plain shells. */
  sinceMs?: number
}

/**
 * Every pane in the app in its stable visual order: workspaces as the navbar
 * lists them, leaves depth-first inside each split tree. Deliberately NOT
 * keyed on the active workspace — the ring must read the same from every
 * pane so repeated presses walk a predictable cycle across workspaces.
 */
export function collectAttentionPanes(
  workspaces: ReadonlyArray<{ layout: LayoutNode }>,
  byId: Record<string, AgentPaneState>
): AttentionPane[] {
  return workspaces.flatMap((ws) =>
    collectLeaves(ws.layout).map((leaf) => ({
      terminalId: leaf.terminalId,
      display: displayState(byId[leaf.terminalId]),
      sinceMs: byId[leaf.terminalId]?.sinceMs
    }))
  )
}

/** Ring order (herdr's attention priority, as in rollup.ts PRIORITY). `unknown`
 *  is intentionally absent: a pane in its spawn grace or whose agent exited
 *  must not hijack the jump. Plain shells (undefined) never qualify either. */
const RING_ORDER: readonly DisplayState[] = ['blocked', 'done', 'working', 'idle']

/** Only the two "look at me" ranks are ordered by age: the pane that has
 *  waited longest for input is the most urgent. working/idle keep visual
 *  order — age carries no urgency there, and reshuffling them on every state
 *  tick would make repeated presses feel random. */
const AGE_ORDERED: ReadonlySet<DisplayState> = new Set(['blocked', 'done'])

/** Terminal ids that qualify, highest priority first; equal priorities keep
 *  their visual order so the cycle is deterministic — except blocked/done,
 *  which go longest-waiting first. */
export function attentionRing(panes: ReadonlyArray<AttentionPane>): string[] {
  return panes
    .map((p, index) => ({
      id: p.terminalId,
      rank: p.display === undefined ? -1 : RING_ORDER.indexOf(p.display),
      wait: p.display !== undefined && AGE_ORDERED.has(p.display) ? p.sinceMs : undefined,
      index
    }))
    .filter((p) => p.rank >= 0)
    .sort((a, b) => a.rank - b.rank || compareWait(a.wait, b.wait) || a.index - b.index)
    .map((p) => p.id)
}

/**
 * The pane to jump to from `current`. Off-ring (plain shell, nothing focused)
 * starts at the top; on-ring advances one and wraps. `undefined` = nothing to
 * do (empty ring, or the focused pane is the only member) so the caller can
 * skip the reveal and let the keystroke fall through.
 */
export function nextAttentionPane(
  panes: ReadonlyArray<AttentionPane>,
  current?: string
): string | undefined {
  const ring = attentionRing(panes)
  if (ring.length === 0) return undefined
  const idx = current === undefined ? -1 : ring.indexOf(current)
  if (idx === -1) return ring[0]
  if (ring.length === 1) return undefined
  return ring[(idx + 1) % ring.length]
}

/** Badge numbers: only the two states that mean "the user should look". */
export function attentionCount(panes: ReadonlyArray<AttentionPane>): { blocked: number; done: number } {
  let blocked = 0
  let done = 0
  for (const p of panes) {
    if (p.display === 'blocked') blocked++
    else if (p.display === 'done') done++
  }
  return { blocked, done }
}
