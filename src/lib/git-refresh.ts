import type { AgentPaneState } from '@/lib/agent-state/rollup'
import type { CommandState } from '@/lib/shell-marks'
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
 * worth one `git status`. Plain Terminal panes publish through OSC 133
 * shell-integration marks instead (shell-mark store, opt-in snippets in the
 * guide); a shell without them still needs the manual ↻. Pure triggers plus
 * a tiny driver with injected timers, like notification-watch.
 */

export const GIT_REFRESH_DEBOUNCE_MS = 400

type States = Record<string, AgentPaneState>
type Commands = Record<string, CommandState>

/** The inputs both triggers share: who is where, and what the panel shows. */
interface RefreshScope {
  cwdOf: (terminalId: string) => string | undefined
  worktrees: readonly { path: string }[]
  selectedWorktreePath: string
  panelVisible: boolean
}

export interface GitRefreshInput extends RefreshScope {
  prev: States
  next: States
}

export interface CommandRefreshInput extends RefreshScope {
  prev: Commands
  next: Commands
}

/**
 * `worktreeOwningCwd`, not containment: `<repo>.worktrees/x` lies inside
 * `<repo>` textually, and its fallback-free form keeps a pane in another repo
 * from refreshing main.
 */
function inSelected(id: string, scope: RefreshScope): boolean {
  const cwd = scope.cwdOf(id)
  if (cwd === undefined) return false
  return worktreeOwningCwd(scope.worktrees, cwd)?.path === scope.selectedWorktreePath
}

/**
 * Ids whose transition should refresh the SELECTED worktree: they left
 * `working` or disappeared, and their cwd is strictly owned by that worktree.
 * Empty while the panel is hidden — it re-fetches on open anyway, so a hidden
 * refresh would only burn a git call.
 */
export function gitRefreshTrigger(input: GitRefreshInput): string[] {
  const { prev, next } = input
  if (!input.panelVisible || input.selectedWorktreePath === '') return []
  const out: string[] = []
  const ids = new Set([...Object.keys(next), ...Object.keys(prev)])
  for (const id of ids) {
    const before = prev[id]
    const after = next[id]
    const removed = before !== undefined && after === undefined
    const leftWorking = before?.state === 'working' && after !== undefined && after.state !== 'working'
    if (!removed && !leftWorking) continue
    if (inSelected(id, input)) out.push(id)
  }
  return out
}

/**
 * Ids whose plain-shell command just finished inside the SELECTED worktree.
 * The signal is the identity of `last`, not the phase: bash/zsh print D and A
 * in the same precmd, so by the time anyone looks the phase is `prompt` again,
 * while `last` is carried by reference through A/B/C and replaced only by the
 * next D — exactly one hit per command, however many redraws follow.
 */
export function commandRefreshTrigger(input: CommandRefreshInput): string[] {
  const { prev, next } = input
  if (!input.panelVisible || input.selectedWorktreePath === '') return []
  const out: string[] = []
  for (const id of Object.keys(next)) {
    const last = next[id]?.last
    if (last === undefined || last === prev[id]?.last) continue
    if (inSelected(id, input)) out.push(id)
  }
  return out
}

export interface GitRefreshWatchDeps {
  subscribeAgentStates: (listener: (next: States, prev: States) => void) => () => void
  /** Shell-mark store snapshots — only plain panes (no agent manifest) publish there. */
  subscribeCommands: (listener: (next: Commands, prev: Commands) => void) => () => void
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
 * Subscribes to agent-state AND shell-mark snapshots and schedules ONE
 * trailing refresh per burst across both sources. The timer is armed by the
 * first qualifying transition and never extended: a War Room stream of
 * transitions must not starve the refresh. Returns the unsubscribe fn (also
 * drops a pending timer).
 */
export function startGitRefreshWatch(deps: GitRefreshWatchDeps): () => void {
  // A pane that just died has no registry entry any more, so its cwd is
  // remembered from the callbacks that saw it alive; the live value wins
  // whenever it still exists (an agent can `cd` after its first publish).
  // One cache serves both sources: a pane is either an agent or a plain
  // shell, so the two stores never publish the same id.
  const cwdById = new Map<string, string>()
  let timer: unknown = undefined

  const onSnapshot = <T>(
    next: Record<string, T>,
    prev: Record<string, T>,
    trigger: (input: RefreshScope & { prev: Record<string, T>; next: Record<string, T> }) => string[]
  ): void => {
    for (const id of Object.keys(next)) {
      const cwd = deps.cwdOf(id)
      if (cwd !== undefined) cwdById.set(id, cwd)
    }
    const git = deps.getGit()
    const due = trigger({
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
  }

  const unsubscribeAgents = deps.subscribeAgentStates((next, prev) => onSnapshot(next, prev, gitRefreshTrigger))
  const unsubscribeCommands = deps.subscribeCommands((next, prev) => onSnapshot(next, prev, commandRefreshTrigger))

  return () => {
    if (timer !== undefined) {
      deps.clearTimer(timer)
      timer = undefined
    }
    unsubscribeAgents()
    unsubscribeCommands()
  }
}
