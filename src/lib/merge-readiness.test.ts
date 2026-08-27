import { describe, expect, it } from 'vitest'
import {
  formatMergeReadiness,
  mergeReadinessTitle,
  mergeReadinessTone,
  mainBranchOf,
} from '@/lib/merge-readiness'
import type { MergeReadiness } from '@/tauri/git'

const clean = (behindMain = 0): MergeReadiness => ({ verdict: { type: 'clean' }, behindMain })
const conflicts = (payload: string[], behindMain = 0): MergeReadiness => ({
  verdict: { type: 'conflicts', payload },
  behindMain,
})
const unknown: MergeReadiness = { verdict: { type: 'unknown' }, behindMain: 0 }

describe('formatMergeReadiness', () => {
  it('clean and up to date', () => {
    expect(formatMergeReadiness(clean(), 'main')).toBe('Merges cleanly into main')
  })
  it('clean but behind appends the behind count', () => {
    expect(formatMergeReadiness(clean(3), 'main')).toBe('Merges cleanly into main · ↓3 behind main')
  })
  it('uses the real main branch name', () => {
    expect(formatMergeReadiness(clean(), 'master')).toBe('Merges cleanly into master')
  })
  it('one conflict is singular', () => {
    expect(formatMergeReadiness(conflicts(['a.ts']), 'main')).toBe('1 conflict with main: a.ts')
  })
  it('lists up to three files then folds the rest', () => {
    expect(formatMergeReadiness(conflicts(['a.ts', 'b.ts']), 'main')).toBe('2 conflicts with main: a.ts, b.ts')
    expect(formatMergeReadiness(conflicts(['a', 'b', 'c', 'd', 'e']), 'main')).toBe(
      '5 conflicts with main: a, b, c +2 more'
    )
  })
  it('conflicts plus behind', () => {
    expect(formatMergeReadiness(conflicts(['a.ts'], 1), 'main')).toBe('1 conflict with main: a.ts · ↓1 behind main')
  })
  it('conflict verdict with no listed paths stays generic', () => {
    expect(formatMergeReadiness(conflicts([]), 'main')).toBe('Conflicts with main')
  })
  it('unknown explains the git requirement and never shows behind', () => {
    expect(formatMergeReadiness({ ...unknown, behindMain: 4 }, 'main')).toBe('Merge check needs git ≥ 2.38')
  })
})

describe('mergeReadinessTitle', () => {
  it('conflicts get the full one-per-line list', () => {
    expect(mergeReadinessTitle(conflicts(['a', 'b', 'c', 'd']), 'main')).toBe(
      'Conflicts with main:\na\nb\nc\nd'
    )
  })
  it('clean and unknown have no title', () => {
    expect(mergeReadinessTitle(clean(2), 'main')).toBeUndefined()
    expect(mergeReadinessTitle(unknown, 'main')).toBeUndefined()
  })
})

describe('mergeReadinessTone', () => {
  it('maps verdicts to tones', () => {
    expect(mergeReadinessTone(clean(5))).toBe('ok')
    expect(mergeReadinessTone(conflicts(['a']))).toBe('warn')
    expect(mergeReadinessTone(unknown)).toBe('muted')
  })
})

describe('mainBranchOf', () => {
  it('reads the main worktree branch', () => {
    expect(mainBranchOf([{ isMain: false, branch: 'swarm/x' }, { isMain: true, branch: 'trunk' }])).toBe('trunk')
  })
  it('falls back to main when absent or detached', () => {
    expect(mainBranchOf([])).toBe('main')
    expect(mainBranchOf([{ isMain: true, branch: '(detached)' }])).toBe('main')
  })
})
