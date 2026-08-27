import { describe, expect, it, vi } from 'vitest'
import type { AgentPaneState } from '@/lib/agent-state/rollup'
import {
  GIT_REFRESH_DEBOUNCE_MS,
  gitRefreshTrigger,
  startGitRefreshWatch,
  type GitRefreshInput,
  type GitRefreshWatchDeps
} from '@/lib/git-refresh'

type States = Record<string, AgentPaneState>
const s = (state: AgentPaneState['state'], seen = true): AgentPaneState => ({ state, seen, sinceMs: 0 })

const MAIN = '/x/myapp'
const ALPHA = '/x/myapp.worktrees/alpha-1'
const worktrees = [{ path: MAIN }, { path: ALPHA }]
const cwds: Record<string, string | undefined> = {
  t1: `${ALPHA}/src`,   // agent inside the alpha worktree
  t2: `${MAIN}/src`,    // agent at the repo root (worktree toggle off)
  t3: '/y/other-repo',  // agent in a different repo
  t4: ALPHA             // second alpha agent (burst partner)
}

const trigger = (prev: States, next: States, over: Partial<GitRefreshInput> = {}): string[] =>
  gitRefreshTrigger({
    prev,
    next,
    cwdOf: (id) => cwds[id],
    worktrees,
    selectedWorktreePath: ALPHA,
    panelVisible: true,
    ...over
  })

describe('gitRefreshTrigger', () => {
  it('fires when an agent inside the selected worktree leaves working (idle / blocked / unknown)', () => {
    expect(trigger({ t1: s('working') }, { t1: s('idle', false) })).toEqual(['t1'])
    expect(trigger({ t1: s('working') }, { t1: s('blocked') })).toEqual(['t1'])
    expect(trigger({ t1: s('working') }, { t1: s('unknown') })).toEqual(['t1'])
  })

  it('fires when a pane that lived in the selected worktree is removed', () => {
    expect(trigger({ t1: s('idle') }, {})).toEqual(['t1'])
  })

  it('ignores entering working, non-working hops, seen flips, and new ids', () => {
    expect(trigger({ t1: s('idle') }, { t1: s('working') })).toEqual([])
    expect(trigger({ t1: s('blocked') }, { t1: s('idle') })).toEqual([])
    expect(trigger({ t1: s('idle', false) }, { t1: s('idle', true) })).toEqual([])
    expect(trigger({}, { t1: s('idle') })).toEqual([])
  })

  it('uses strict ownership: the alpha agent does not refresh main, another repo refreshes nothing', () => {
    expect(trigger({ t1: s('working') }, { t1: s('idle') }, { selectedWorktreePath: MAIN })).toEqual([])
    expect(trigger({ t3: s('working') }, { t3: s('idle') }, { selectedWorktreePath: MAIN })).toEqual([])
  })

  it('an agent at the repo root refreshes main when main is selected (worktree toggle off)', () => {
    expect(trigger({ t2: s('working') }, { t2: s('idle') }, { selectedWorktreePath: MAIN })).toEqual(['t2'])
  })

  it('reports only the panes in the selected worktree out of a mixed burst', () => {
    expect(trigger(
      { t1: s('working'), t2: s('working') },
      { t1: s('idle'), t2: s('idle') }
    )).toEqual(['t1'])
  })

  it('is silent when the panel is hidden, nothing is selected, or the cwd is unknown', () => {
    const p = { t1: s('working') }
    const n = { t1: s('idle') }
    expect(trigger(p, n, { panelVisible: false })).toEqual([])
    expect(trigger(p, n, { selectedWorktreePath: '' })).toEqual([])
    expect(trigger(p, n, { cwdOf: () => undefined })).toEqual([])
  })
})

interface Harness {
  emit: (next: States, prev: States) => void
  fireTimers: () => void
  refresh: ReturnType<typeof vi.fn>
  setTimer: ReturnType<typeof vi.fn>
  clearTimer: ReturnType<typeof vi.fn>
  live: Record<string, string | undefined>
  git: { panelVisible: boolean; worktrees: { path: string }[]; selectedWorktreePath: string }
  stop: () => void
}

function harness(): Harness {
  let listener: ((n: States, p: States) => void) | null = null
  const timers = new Map<number, () => void>()
  let nextHandle = 1
  const refresh = vi.fn()
  const live: Record<string, string | undefined> = { ...cwds }
  const git = { panelVisible: true, worktrees: [...worktrees], selectedWorktreePath: ALPHA }
  const setTimer = vi.fn((fn: () => void, ms: number) => {
    expect(ms).toBe(GIT_REFRESH_DEBOUNCE_MS)
    const h = nextHandle++
    timers.set(h, fn)
    return h
  })
  const clearTimer = vi.fn((h: unknown) => { timers.delete(h as number) })
  const deps: GitRefreshWatchDeps = {
    subscribeAgentStates: (l) => {
      listener = l
      return () => { listener = null }
    },
    cwdOf: (id) => live[id],
    getGit: () => git,
    refreshSelected: refresh,
    setTimer,
    clearTimer
  }
  const stop = startGitRefreshWatch(deps)
  return {
    emit: (next, prev) => listener?.(next, prev),
    fireTimers: () => {
      const fns = [...timers.values()]
      timers.clear()
      fns.forEach((fn) => fn())
    },
    refresh,
    setTimer,
    clearTimer,
    live,
    git,
    stop
  }
}

describe('startGitRefreshWatch', () => {
  it('debounces a burst into one refresh', () => {
    const h = harness()
    h.emit({ t1: s('idle'), t4: s('working') }, { t1: s('working'), t4: s('working') })
    h.emit({ t1: s('idle'), t4: s('idle') }, { t1: s('idle'), t4: s('working') })
    expect(h.setTimer).toHaveBeenCalledTimes(1)
    expect(h.refresh).not.toHaveBeenCalled()
    h.fireTimers()
    expect(h.refresh).toHaveBeenCalledTimes(1)
  })

  it('a steady stream does not extend the timer: the refresh lands, then re-arms', () => {
    const h = harness()
    h.emit({ t1: s('idle') }, { t1: s('working') })
    h.emit({ t1: s('working') }, { t1: s('idle') })
    h.emit({ t1: s('blocked') }, { t1: s('working') })
    expect(h.setTimer).toHaveBeenCalledTimes(1)
    h.fireTimers()
    expect(h.refresh).toHaveBeenCalledTimes(1)
    h.emit({ t1: s('idle') }, { t1: s('blocked') })   // blocked → idle is not a trigger
    expect(h.setTimer).toHaveBeenCalledTimes(1)
    h.emit({ t1: s('working') }, { t1: s('idle') })
    h.emit({ t1: s('idle') }, { t1: s('working') })
    expect(h.setTimer).toHaveBeenCalledTimes(2)
    h.fireTimers()
    expect(h.refresh).toHaveBeenCalledTimes(2)
  })

  it('resolves a removed pane through the cwd it had while alive', () => {
    const h = harness()
    h.emit({ t1: s('working') }, {})   // seen alive once: cwd cached
    h.live.t1 = undefined              // registry entry gone with the pty
    h.emit({}, { t1: s('working') })
    expect(h.setTimer).toHaveBeenCalledTimes(1)
    h.fireTimers()
    expect(h.refresh).toHaveBeenCalledTimes(1)
  })

  it('an agent in another repo never refreshes this one', () => {
    const h = harness()
    h.emit({ t3: s('idle') }, { t3: s('working') })
    expect(h.setTimer).not.toHaveBeenCalled()
  })

  it('stays silent while the panel is hidden', () => {
    const h = harness()
    h.git.panelVisible = false
    h.emit({ t1: s('idle') }, { t1: s('working') })
    expect(h.setTimer).not.toHaveBeenCalled()
  })

  it('stop() clears a pending refresh', () => {
    const h = harness()
    h.emit({ t1: s('idle') }, { t1: s('working') })
    h.stop()
    expect(h.clearTimer).toHaveBeenCalledTimes(1)
    h.fireTimers()
    expect(h.refresh).not.toHaveBeenCalled()
  })
})
