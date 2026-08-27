import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentStateStore } from '@/store/agent-state-store'

const publish = (
  state: Parameters<ReturnType<typeof useAgentStateStore.getState>['publish']>[1],
  watched = false,
  nowMs = 0
): void => useAgentStateStore.getState().publish('t1', state, { paneWatched: watched, nowMs })

describe('agent-state-store', () => {
  beforeEach(() => {
    useAgentStateStore.setState({ byId: {} })
  })

  it('non-idle states are always seen', () => {
    publish('working')
    expect(useAgentStateStore.getState().byId['t1']).toEqual({ state: 'working', seen: true, sinceMs: 0 })
  })

  it('working → idle while unwatched becomes done (seen=false)', () => {
    publish('working')
    publish('idle')
    expect(useAgentStateStore.getState().byId['t1']).toEqual({ state: 'idle', seen: false, sinceMs: 0 })
  })

  it('blocked → idle is also a completion', () => {
    publish('blocked')
    publish('idle')
    expect(useAgentStateStore.getState().byId['t1'].seen).toBe(false)
  })

  it('working → idle while the pane is watched is plain idle', () => {
    publish('working')
    publish('idle', true)
    expect(useAgentStateStore.getState().byId['t1']).toEqual({ state: 'idle', seen: true, sinceMs: 0 })
  })

  it('unknown → idle is NOT a completion (startup settle, deviation from herdr)', () => {
    publish('unknown')
    publish('idle')
    expect(useAgentStateStore.getState().byId['t1'].seen).toBe(true)
  })

  it('same-state republish never clears an existing done badge', () => {
    publish('working')
    publish('idle')
    publish('idle', true)
    expect(useAgentStateStore.getState().byId['t1'].seen).toBe(false)
  })

  it('markSeen clears the done badge; clear removes the entry', () => {
    publish('working')
    publish('idle')
    useAgentStateStore.getState().markSeen('t1')
    expect(useAgentStateStore.getState().byId['t1'].seen).toBe(true)
    useAgentStateStore.getState().clear('t1')
    expect(useAgentStateStore.getState().byId['t1']).toBeUndefined()
  })

  it('stamps sinceMs from nowMs on every state change', () => {
    publish('working', false, 1_000)
    expect(useAgentStateStore.getState().byId['t1'].sinceMs).toBe(1_000)
    publish('blocked', false, 5_000)
    expect(useAgentStateStore.getState().byId['t1'].sinceMs).toBe(5_000)
  })

  it('same-state republish keeps the original stamp (age must not reset on a steady idle)', () => {
    publish('idle', false, 1_000)
    publish('idle', true, 9_000)
    expect(useAgentStateStore.getState().byId['t1'].sinceMs).toBe(1_000)
  })

  it('markSeen keeps the stamp', () => {
    publish('working', false, 1_000)
    publish('idle', false, 4_000)
    useAgentStateStore.getState().markSeen('t1')
    expect(useAgentStateStore.getState().byId['t1']).toEqual({ state: 'idle', seen: true, sinceMs: 4_000 })
  })

  it('a completion is stamped with the finish time, not the start of work', () => {
    publish('working', false, 1_000)
    publish('idle', false, 4_000)
    expect(useAgentStateStore.getState().byId['t1']).toEqual({ state: 'idle', seen: false, sinceMs: 4_000 })
  })
})
