import { beforeEach, describe, expect, it } from 'vitest'
import { useShellMarkStore } from './shell-mark-store'

describe('shell-mark-store', () => {
  beforeEach(() => useShellMarkStore.setState({ byId: {} }))

  it('applies marks through the state machine per terminal', () => {
    const { applyMark } = useShellMarkStore.getState()
    applyMark('t1', { kind: 'A' }, 0)
    applyMark('t1', { kind: 'C' }, 10)
    applyMark('t2', { kind: 'A' }, 0)
    applyMark('t1', { kind: 'D', exitCode: 0 }, 60)
    expect(useShellMarkStore.getState().byId).toEqual({
      t1: { phase: 'finished', last: { startedAt: 10, finishedAt: 60, durationMs: 50, exitCode: 0 } },
      t2: { phase: 'prompt' }
    })
  })

  it('a mark that is not a transition keeps the same byId reference (no subscriber churn)', () => {
    useShellMarkStore.getState().applyMark('t1', { kind: 'A' }, 0)
    const before = useShellMarkStore.getState().byId
    useShellMarkStore.getState().applyMark('t1', { kind: 'D', exitCode: 0 }, 1) // first-prompt D;0
    useShellMarkStore.getState().applyMark('t1', { kind: 'A' }, 2)
    expect(useShellMarkStore.getState().byId).toBe(before)
  })

  it('clear drops the terminal and is a no-op (same reference) for an unknown id', () => {
    useShellMarkStore.getState().applyMark('t1', { kind: 'A' }, 0)
    useShellMarkStore.getState().clear('t1')
    expect('t1' in useShellMarkStore.getState().byId).toBe(false)
    const before = useShellMarkStore.getState().byId
    useShellMarkStore.getState().clear('missing')
    expect(useShellMarkStore.getState().byId).toBe(before)
  })
})
