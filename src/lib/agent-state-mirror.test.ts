import { describe, expect, it, vi } from 'vitest'
import type { AgentPaneState } from '@/lib/agent-state/rollup'
import {
  mirrorChanges,
  startAgentStateMirror,
  type AgentStateMirrorDeps,
  type MirrorChange
} from '@/lib/agent-state-mirror'

type States = Record<string, AgentPaneState>

const working: AgentPaneState = { state: 'working', seen: true, sinceMs: 0 }
const blocked: AgentPaneState = { state: 'blocked', seen: true, sinceMs: 0 }
const idleSeen: AgentPaneState = { state: 'idle', seen: true, sinceMs: 0 }
const idleUnseen: AgentPaneState = { state: 'idle', seen: false, sinceMs: 0 }
const unknown: AgentPaneState = { state: 'unknown', seen: true, sinceMs: 0 }

describe('mirrorChanges', () => {
  it('reports a new id with displayState semantics', () => {
    expect(mirrorChanges({}, { a: working })).toEqual<MirrorChange[]>([{ id: 'a', display: 'working' }])
    // Unseen idle is the "done" badge — Rust must see what the user sees.
    expect(mirrorChanges({}, { a: idleUnseen })).toEqual([{ id: 'a', display: 'done' }])
  })

  it('reports nothing when an entry is unchanged', () => {
    expect(mirrorChanges({ a: working }, { a: working })).toEqual([])
    // Same-valued but new object identity is still "unchanged" — the diff is
    // on display state, not on reference.
    expect(mirrorChanges({ a: working }, { a: { state: 'working', seen: true, sinceMs: 0 } })).toEqual([])
  })

  it('reports a state change', () => {
    expect(mirrorChanges({ a: working }, { a: blocked })).toEqual([{ id: 'a', display: 'blocked' }])
  })

  it('treats a seen flip on idle as a change (working → done → idle)', () => {
    expect(mirrorChanges({ a: working }, { a: idleUnseen })).toEqual([{ id: 'a', display: 'done' }])
    expect(mirrorChanges({ a: idleUnseen }, { a: idleSeen })).toEqual([{ id: 'a', display: 'idle' }])
  })

  it('ignores a seen flip that does not change the display state', () => {
    expect(mirrorChanges({ a: { state: 'working', seen: false, sinceMs: 0 } }, { a: working })).toEqual([])
  })

  it('does NOT report ids removed from cur (Rust forgets on pty death itself)', () => {
    expect(mirrorChanges({ a: working, b: blocked }, { a: working })).toEqual([])
  })

  it('unknown → unknown is not a change', () => {
    expect(mirrorChanges({ a: unknown }, { a: unknown })).toEqual([])
  })

  it('reports several ids independently, in cur key order', () => {
    const prev: States = { a: working, b: working, c: idleSeen }
    const cur: States = { a: working, b: blocked, c: idleUnseen, d: unknown }
    expect(mirrorChanges(prev, cur)).toEqual([
      { id: 'b', display: 'blocked' },
      { id: 'c', display: 'done' },
      { id: 'd', display: 'unknown' }
    ])
  })
})

describe('startAgentStateMirror', () => {
  type Listener = Parameters<AgentStateMirrorDeps['subscribe']>[0]

  function harness(initial: States) {
    let listener: Listener | undefined
    const unsubscribe = vi.fn()
    const report = vi.fn<AgentStateMirrorDeps['report']>()
    const deps: AgentStateMirrorDeps = {
      subscribe: vi.fn((l: Listener) => {
        listener = l
        return unsubscribe
      }),
      getStates: () => initial,
      report
    }
    const stop = startAgentStateMirror(deps)
    return { deps, report, unsubscribe, stop, fire: (next: States, prev: States) => listener?.(next, prev) }
  }

  it('reports every existing state once on start so a late install stays consistent', () => {
    const { report } = harness({ a: working, b: idleUnseen })
    expect(report.mock.calls).toEqual([
      ['a', 'working'],
      ['b', 'done']
    ])
  })

  it('reports nothing on start when the store is empty', () => {
    const { report, deps } = harness({})
    expect(report).not.toHaveBeenCalled()
    expect(deps.subscribe).toHaveBeenCalledTimes(1)
  })

  it('reports only diffs on each subscribe callback', () => {
    const { report, fire } = harness({ a: working })
    report.mockClear()
    fire({ a: working, b: blocked }, { a: working })
    expect(report.mock.calls).toEqual([['b', 'blocked']])
    report.mockClear()
    fire({ a: working, b: blocked }, { a: working, b: blocked })
    expect(report).not.toHaveBeenCalled()
    report.mockClear()
    fire({ a: idleUnseen }, { a: working, b: blocked })
    expect(report.mock.calls).toEqual([['a', 'done']])
  })

  it('returned fn unsubscribes', () => {
    const { unsubscribe, stop } = harness({})
    expect(unsubscribe).not.toHaveBeenCalled()
    stop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
