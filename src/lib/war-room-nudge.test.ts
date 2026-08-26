import { describe, expect, it } from 'vitest'
import {
  buildIntroText,
  buildNudgeText,
  deliveryHoldReason,
  flushQueue,
  holdReasonCopy,
  type PendingDelivery,
  TYPING_QUIET_MS,
  shouldDeferDelivery
} from './war-room-nudge'

const probe = (fromName: string): PendingDelivery => ({ fromName, mode: 'probe' })
const exec = (fromName: string, content: string): PendingDelivery => ({ fromName, mode: 'execute', content })

describe('buildNudgeText', () => {
  it('names the single sender and both tools', () => {
    const t = buildNudgeText(['Codex'])
    expect(t).toContain('Codex')
    expect(t).toContain('war_room.read_inbox')
    expect(t).toContain('war_room.send')
  })

  it('counts multiple messages and dedupes sender names', () => {
    const t = buildNudgeText(['Codex', 'Claude', 'Codex'])
    expect(t).toContain('3')
    expect(t.indexOf('Codex')).toBe(t.lastIndexOf('Codex'))
  })
})

describe('buildIntroText', () => {
  it('lists peers and all three tools', () => {
    const t = buildIntroText('War Room', ['Codex', 'Claude'])
    expect(t).toContain('Codex')
    expect(t).toContain('war_room.list_peers')
    expect(t).toContain('war_room.send')
    expect(t).toContain('war_room.read_inbox')
  })

  it('still reads sensibly with no peers yet', () => {
    expect(buildIntroText('War Room', [])).toContain('war_room.list_peers')
  })

  it('tells agents the Moderator is the human user and is reachable', () => {
    const t = buildIntroText('War Room', ['Codex'])
    expect(t).toContain('Moderator')
    expect(t).toContain('__moderator__')
  })

  it('intro names the room', () => {
    const text = buildIntroText('Website A', ['Codex'])
    expect(text).toContain('War Room "Website A"')
    expect(text).toContain('with Codex')
  })
})

describe('flushQueue', () => {
  it('is empty for an empty queue', () => {
    expect(flushQueue([])).toEqual([])
  })

  it('collapses many probes into one nudge', () => {
    const out = flushQueue([probe('A'), probe('B'), probe('A')])
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('3')
  })

  it('keeps execute payloads verbatim, in order, before the merged nudge', () => {
    const out = flushQueue([exec('A', 'first task'), probe('B'), exec('A', 'second task')])
    expect(out).toEqual(['first task', 'second task', buildNudgeText(['B'])])
  })
})

describe('shouldDeferDelivery', () => {
  const NOW = 1_000_000

  it('does not defer for a pane with no typing history', () => {
    expect(shouldDeferDelivery({ focused: true, lastKeyAt: undefined, dirty: false }, NOW)).toBe(false)
    expect(shouldDeferDelivery({ focused: false, lastKeyAt: undefined, dirty: false }, NOW)).toBe(false)
  })

  it('defers on an unsubmitted line even when the pane is not focused', () => {
    // A half-typed line in pane A is just as destructible after the user
    // clicks into pane B — focus at delivery time says nothing about it.
    expect(shouldDeferDelivery({ focused: false, lastKeyAt: NOW - 60_000, dirty: true }, NOW)).toBe(true)
  })

  it('defers on a focused pane typed in recently', () => {
    expect(shouldDeferDelivery({ focused: true, lastKeyAt: NOW - 100, dirty: false }, NOW)).toBe(true)
  })

  it('stops deferring once the quiet window elapses', () => {
    expect(shouldDeferDelivery({ focused: true, lastKeyAt: NOW - (TYPING_QUIET_MS - 1), dirty: false }, NOW)).toBe(true)
    expect(shouldDeferDelivery({ focused: true, lastKeyAt: NOW - TYPING_QUIET_MS, dirty: false }, NOW)).toBe(false)
  })

  it('ignores recency for an unfocused clean pane', () => {
    expect(shouldDeferDelivery({ focused: false, lastKeyAt: NOW - 10, dirty: false }, NOW)).toBe(false)
  })
})

describe('deliveryHoldReason', () => {
  const now = 100_000
  const clean = { focused: false, lastKeyAt: undefined, dirty: false }

  it('holds an unfocused clean pane whose agent is blocked', () => {
    // A permission/question prompt is output-idle, so the clock gate alone
    // would flush into it — and the flush's Enter would be an approval.
    expect(deliveryHoldReason({ ...clean, agentState: 'blocked' }, now)).toBe('agent-blocked')
  })

  it('holds while the agent is working', () => {
    expect(deliveryHoldReason({ ...clean, agentState: 'working' }, now)).toBe('agent-working')
  })

  it('does not hold on idle, unknown, or no engine opinion', () => {
    expect(deliveryHoldReason({ ...clean, agentState: 'idle' }, now)).toBeNull()
    expect(deliveryHoldReason({ ...clean, agentState: 'unknown' }, now)).toBeNull()
    expect(deliveryHoldReason(clean, now)).toBeNull()
  })

  it('agent-blocked wins over a dirty line', () => {
    expect(deliveryHoldReason({ ...clean, dirty: true, agentState: 'blocked' }, now)).toBe('agent-blocked')
  })

  it('reports typing when the agent is idle but a line is unsubmitted', () => {
    expect(deliveryHoldReason({ ...clean, dirty: true, agentState: 'idle' }, now)).toBe('typing')
  })

  it('reports typing for a focused, recently typed-in pane', () => {
    expect(deliveryHoldReason({ focused: true, lastKeyAt: now - 1, dirty: false }, now)).toBe('typing')
    expect(deliveryHoldReason({ focused: true, lastKeyAt: now - TYPING_QUIET_MS, dirty: false }, now)).toBeNull()
  })

  it('shouldDeferDelivery is true for a blocked agent', () => {
    expect(shouldDeferDelivery({ ...clean, agentState: 'blocked' }, now)).toBe(true)
  })
})

describe('holdReasonCopy', () => {
  it('only the typing hold is user-releasable', () => {
    // "Deliver now" clears the typing signal, which is meaningless against an
    // agent hold — and a true bypass would press Enter on the prompt.
    expect(holdReasonCopy('typing').releasable).toBe(true)
    expect(holdReasonCopy('agent-blocked').releasable).toBe(false)
    expect(holdReasonCopy('agent-working').releasable).toBe(false)
  })

  it('names the cause in the title', () => {
    expect(holdReasonCopy('agent-blocked').title).toMatch(/permission|prompt/i)
    expect(holdReasonCopy('agent-working').title).toMatch(/working/i)
    expect(holdReasonCopy('typing').title).toMatch(/typing/i)
  })
})
