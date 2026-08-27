import type { AgentPaneState } from '@/lib/agent-state/rollup'
import { worktreeOwningCwd } from '@/lib/worktree-match'

/**
 * Git panel self-refresh.
 *
 * The panel only re-fetched on a cwd change or a panel toggle, so an agent's
 * edits and commits (and the merge verdict) stayed frozen until the user
 * closed and reopened the tab. There is no filesystem watcher and no polling
 * (cost across N worktrees is a product decision) — the agent-state store is
 * the signal: a pane leaving `working` (idle, blocked, or the `unknown` of a
 * respawn) or vanishing is the moment its edits are settled enough to be
 * worth one `git status`. Plain Terminal panes never publish state, so a
 * hand-typed commit still needs a toggle (known limit). Pure trigger plus a
 * tiny driver with injected timers, like notification-watch.
 */

export const GIT_REFRESH_DEBOUNCE_MS = 400

type States = Record<string, AgentPaneState>

export interface GitRefreshInput {
  prev: States
  next: States
  cwdOf: (terminalId: string) => string | undefined
  worktrees: readonly { path: string }[]
  selectedWorktreePath: string
  panelVisible: boolean
}

/**
 * Ids whose transition should refresh the SELECTED worktree: they left
 * `working` or disappeared, and their cwd is strictly owned by that worktree.
 * `worktreeOwningCwd`, not containment: `<repo>.worktrees/x` lies inside
 * `<repo>` textually, and its fallback-free form keeps an agent in another
 * repo from refreshing main. Empty while the panel is hidden — it re-fetches
 * on open anyway, so a hidden refresh would only burn a git call.
 */
export function gitRefreshTrigger(input: GitRefreshInput): string[] {
  const { prev, next, cwdOf, worktrees, selectedWorktreePath, panelVisible } = input
  if (!panelVisible || selectedWorktreePath === '') return []
  const out: string[] = []
  const ids = new Set([...Object.keys(next), ...Object.keys(prev)])
  for (const id of ids) {
    const before = prev[id]
    const after = next[id]
    const removed = before !== undefined && after === undefined
    const leftWorking = before?.state === 'working' && after !== undefined && after.state !== 'working'
    if (!removed && !leftWorking) continue
    const cwd = cwdOf(id)
    if (cwd === undefined) continue
    if (worktreeOwningCwd(worktrees, cwd)?.path === selectedWorktreePath) out.push(id)
  }
  return out
}

export interface GitRefreshWatchDeps {
  subscribeAgentStates: (listener: (next: States, prev: States) => void) => () => void
  /** Live cwd of a pane (OSC 7 or spawn cwd); `undefined` once its registry entry is gone. */
  cwdOf: (terminalId: string) => string | undefined
  getGit: () => {
    panelVisible: boolean
    worktrees: readonly { path: string }[]
    selectedWorktreePath: string
  }
  refreshSelected: () => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

/**
 * Subscribes to agent-state snapshots and schedules ONE trailing refresh per
 * burst. The timer is armed by the first qualifying transition and never
 * extended: a War Room stream of transitions must not starve the refresh.
 * Returns the unsubscribe fn (also drops a pending timer).
 */
export function startGitRefreshWatch(deps: GitRefreshWatchDeps): () => void {
  // A pane that just died has no registry entry any more, so its cwd is
  // remembered from the callbacks that saw it alive; the live value wins
  // whenever it still exists (an agent can `cd` after its first publish).
  const cwdById = new Map<string, string>()
  let timer: unknown = undefined

  const unsubscribe = deps.subscribeAgentStates((next, prev) => {
    for (const id of Object.keys(next)) {
      const cwd = deps.cwdOf(id)
      if (cwd !== undefined) cwdById.set(id, cwd)
    }
    const git = deps.getGit()
    const due = gitRefreshTrigger({
      prev,
      next,
      cwdOf: (id) => deps.cwdOf(id) ?? cwdById.get(id),
      worktrees: git.worktrees,
      selectedWorktreePath: git.selectedWorktreePath,
      panelVisible: git.panelVisible
    })
    for (const id of Object.keys(prev)) if (!(id in next)) cwdById.delete(id)
    if (due.length === 0 || timer !== undefined) return
    timer = deps.setTimer(() => {
      timer = undefined
      deps.refreshSelected()
    }, GIT_REFRESH_DEBOUNCE_MS)
  })

  return () => {
    if (timer !== undefined) {
      deps.clearTimer(timer)
      timer = undefined
    }
    unsubscribe()
  }
}
