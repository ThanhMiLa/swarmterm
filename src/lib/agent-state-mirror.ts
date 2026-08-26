import { displayState, type AgentPaneState } from '@/lib/agent-state/rollup'
import type { DisplayState } from '@/lib/agent-state/types'

/**
 * Renderer → Rust mirror of the agent *display* state.
 *
 * Rust owns the pty but has no idea what the agent inside it is doing — the
 * state engine (`lib/agent-state`) runs on the renderer, off xterm's parsed
 * output. The M2 War Room verbs (`war_room.wait_peer` / `read_peer`, T3.2)
 * are answered by the Rust MCP server, so the renderer has to push its verdict
 * down. It pushes the DISPLAY state (`done` for unseen idle), not the raw
 * engine state, so a peer agent sees exactly the badge the user sees.
 *
 * Pure diff + a tiny subscription driver; the IPC call is injected so this
 * stays unit-testable without Tauri.
 */

export interface MirrorChange {
  id: string
  display: DisplayState
}

type States = Record<string, AgentPaneState>

/**
 * Entries whose display state differs between `prev` and `cur`, in `cur` key
 * order. Ids missing from `cur` are NOT reported: the pty death that removed
 * them already ran `forget` on the Rust side (both `kill_terminal` and
 * `read_loop`), and a late "unknown" here would resurrect the row.
 */
export function mirrorChanges(prev: States, cur: States): MirrorChange[] {
  const out: MirrorChange[] = []
  for (const id of Object.keys(cur)) {
    const display = displayState(cur[id])
    if (display === undefined) continue
    if (displayState(prev[id]) === display) continue
    out.push({ id, display })
  }
  return out
}

export interface AgentStateMirrorDeps {
  subscribe: (l: (next: States, prev: States) => void) => () => void
  getStates: () => States
  report: (id: string, display: DisplayState) => void
}

/**
 * Start mirroring: report every existing state once (the effect may mount
 * after panes already produced state), then only diffs per store callback.
 * Returns the unsubscribe fn.
 */
export function startAgentStateMirror(deps: AgentStateMirrorDeps): () => void {
  for (const change of mirrorChanges({}, deps.getStates())) {
    deps.report(change.id, change.display)
  }
  return deps.subscribe((next, prev) => {
    for (const change of mirrorChanges(prev, next)) {
      deps.report(change.id, change.display)
    }
  })
}
