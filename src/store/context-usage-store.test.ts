import { beforeEach, describe, expect, it } from 'vitest'
import { useContextUsageStore } from './context-usage-store'

describe('context-usage-store', () => {
  beforeEach(() => useContextUsageStore.setState({ byId: {} }))

  it('records the rounded percentage per terminal', () => {
    const { apply } = useContextUsageStore.getState()
    apply('t1', 63)
    apply('t2', 12.6)
    apply('t1', 41)
    expect(useContextUsageStore.getState().byId).toEqual({ t1: 41, t2: 13 })
  })

  it('a sample that is not a change keeps the same byId reference (no subscriber churn)', () => {
    useContextUsageStore.getState().apply('t1', 63)
    const before = useContextUsageStore.getState().byId
    useContextUsageStore.getState().apply('t1', 63)
    useContextUsageStore.getState().apply('t1', 63.2)
    useContextUsageStore.getState().apply('t2', null) // Forget on a pane that never showed anything
    expect(useContextUsageStore.getState().byId).toBe(before)
  })

  it('null and clear drop the terminal; clear is a no-op (same reference) for an unknown id', () => {
    useContextUsageStore.getState().apply('t1', 63)
    useContextUsageStore.getState().apply('t1', null)
    expect('t1' in useContextUsageStore.getState().byId).toBe(false)
    useContextUsageStore.getState().apply('t1', 7)
    useContextUsageStore.getState().clear('t1')
    expect('t1' in useContextUsageStore.getState().byId).toBe(false)
    const before = useContextUsageStore.getState().byId
    useContextUsageStore.getState().clear('missing')
    expect(useContextUsageStore.getState().byId).toBe(before)
  })
})
