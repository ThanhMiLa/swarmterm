import { describe, expect, it } from 'vitest'
import type { LayoutNode } from '@/lib/layout-tree'
import type { AgentPaneState } from '@/lib/agent-state/rollup'
import {
  attentionCount,
  attentionRing,
  collectAttentionPanes,
  nextAttentionPane,
  type AttentionPane
} from '@/lib/attention'

const leaf = (id: string): LayoutNode => ({ type: 'leaf', id: `leaf-${id}`, terminalId: id })
const split = (a: LayoutNode, b: LayoutNode): LayoutNode => ({
  type: 'split',
  id: `split-${a.id}-${b.id}`,
  direction: 'horizontal',
  sizes: [50, 50],
  children: [a, b]
})
const working: AgentPaneState = { state: 'working', seen: true, sinceMs: 0 }
const blocked: AgentPaneState = { state: 'blocked', seen: true, sinceMs: 0 }
const done: AgentPaneState = { state: 'idle', seen: false, sinceMs: 0 }
const pane = (terminalId: string, display: AttentionPane['display'], sinceMs?: number): AttentionPane => ({
  terminalId,
  display,
  sinceMs
})

describe('collectAttentionPanes', () => {
  it('walks workspaces in navbar order and leaves depth-first (visual order)', () => {
    const workspaces = [{ layout: split(leaf('a'), split(leaf('b'), leaf('c'))) }, { layout: leaf('d') }]
    expect(collectAttentionPanes(workspaces, {}).map((p) => p.terminalId)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('maps store state through displayState; plain shells (no entry) are undefined', () => {
    const workspaces = [{ layout: split(leaf('a'), leaf('b')) }]
    expect(collectAttentionPanes(workspaces, { a: done })).toEqual([
      { terminalId: 'a', display: 'done', sinceMs: 0 },
      { terminalId: 'b', display: undefined, sinceMs: undefined }
    ])
  })

  it('copies sinceMs from the store entry', () => {
    const workspaces = [{ layout: leaf('a') }]
    expect(collectAttentionPanes(workspaces, { a: { ...blocked, sinceMs: 777 } })[0].sinceMs).toBe(777)
  })

  it('maps every engine state, including blocked', () => {
    const workspaces = [{ layout: split(leaf('a'), leaf('b')) }]
    expect(collectAttentionPanes(workspaces, { a: blocked, b: working }).map((p) => p.display)).toEqual([
      'blocked',
      'working'
    ])
  })

  it('returns [] for no workspaces', () => {
    expect(collectAttentionPanes([], {})).toEqual([])
  })
})

describe('attentionRing', () => {
  it('orders blocked > done > working > idle', () => {
    const panes = [pane('i', 'idle'), pane('w', 'working'), pane('d', 'done'), pane('b', 'blocked')]
    expect(attentionRing(panes)).toEqual(['b', 'd', 'w', 'i'])
  })

  it('keeps input (visual) order among equal priorities', () => {
    const panes = [pane('b2', 'blocked'), pane('w1', 'working'), pane('b1', 'blocked'), pane('w2', 'working')]
    expect(attentionRing(panes)).toEqual(['b2', 'b1', 'w1', 'w2'])
  })

  it('drops plain shells (undefined) and unknown (spawn grace / exited)', () => {
    const panes = [pane('plain', undefined), pane('u', 'unknown'), pane('w', 'working')]
    expect(attentionRing(panes)).toEqual(['w'])
  })

  it('is empty when nothing is an agent', () => {
    expect(attentionRing([pane('plain', undefined)])).toEqual([])
  })

  it('within blocked, the longest-waiting pane comes first regardless of visual order', () => {
    const panes = [pane('b-new', 'blocked', 900), pane('b-old', 'blocked', 100), pane('w', 'working', 0)]
    expect(attentionRing(panes)).toEqual(['b-old', 'b-new', 'w'])
  })

  it('within done, the earliest finish comes first', () => {
    const panes = [pane('d-new', 'done', 900), pane('d-old', 'done', 100)]
    expect(attentionRing(panes)).toEqual(['d-old', 'd-new'])
  })

  it('working and idle keep visual order even when stamped (age carries no urgency there)', () => {
    const panes = [pane('w-new', 'working', 900), pane('w-old', 'working', 100), pane('i-new', 'idle', 900), pane('i-old', 'idle', 100)]
    expect(attentionRing(panes)).toEqual(['w-new', 'w-old', 'i-new', 'i-old'])
  })

  it('equal stamps fall back to visual order', () => {
    const panes = [pane('b2', 'blocked', 5), pane('b1', 'blocked', 5)]
    expect(attentionRing(panes)).toEqual(['b2', 'b1'])
  })
})

describe('nextAttentionPane', () => {
  const panes = [pane('w', 'working'), pane('b', 'blocked'), pane('plain', undefined), pane('d', 'done')]
  // ring = ['b', 'd', 'w']

  it('starts at the top of the ring when nothing is focused', () => {
    expect(nextAttentionPane(panes, undefined)).toBe('b')
  })

  it('starts at the top when the focused pane is not in the ring (plain shell)', () => {
    expect(nextAttentionPane(panes, 'plain')).toBe('b')
  })

  it('advances to the pane after the focused one', () => {
    expect(nextAttentionPane(panes, 'b')).toBe('d')
    expect(nextAttentionPane(panes, 'd')).toBe('w')
  })

  it('wraps around from the last ring member', () => {
    expect(nextAttentionPane(panes, 'w')).toBe('b')
  })

  it('is a no-op (undefined) when the ring is empty', () => {
    expect(nextAttentionPane([pane('plain', undefined)], 'plain')).toBeUndefined()
  })

  it('is a no-op when the focused pane is the only ring member', () => {
    expect(nextAttentionPane([pane('plain', undefined), pane('w', 'working')], 'w')).toBeUndefined()
  })

  it('does not depend on which workspace is active — same input, same ring', () => {
    const a = collectAttentionPanes([{ layout: leaf('x') }, { layout: leaf('y') }], { x: working, y: blocked })
    expect(nextAttentionPane(a, undefined)).toBe('y')
    expect(nextAttentionPane(a, 'y')).toBe('x')
  })
})

describe('attentionCount', () => {
  it('counts blocked and done only', () => {
    const panes = [
      pane('b1', 'blocked'),
      pane('b2', 'blocked'),
      pane('d', 'done'),
      pane('w', 'working'),
      pane('i', 'idle'),
      pane('u', 'unknown'),
      pane('p', undefined)
    ]
    expect(attentionCount(panes)).toEqual({ blocked: 2, done: 1 })
  })

  it('is zero/zero when empty', () => {
    expect(attentionCount([])).toEqual({ blocked: 0, done: 0 })
  })
})
