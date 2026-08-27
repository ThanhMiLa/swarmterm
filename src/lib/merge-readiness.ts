import type { MergeReadiness } from '@/tauri/git'

export type MergeTone = 'ok' | 'warn' | 'muted'

// The footer is a single line; anything past this many paths goes into the
// title (see mergeReadinessTitle), which carries the full list.
const CONFLICT_PREVIEW = 3

export function formatMergeReadiness(r: MergeReadiness, mainBranch: string): string {
  const { verdict } = r
  // An Unknown probe never proved anything about the branch, so a behind count
  // next to it would read as a verdict. Only clean/conflicts earn the suffix.
  if (verdict.type === 'unknown') return 'Merge check needs git ≥ 2.38'

  const behind = r.behindMain > 0 ? ` · ↓${r.behindMain} behind ${mainBranch}` : ''
  if (verdict.type === 'clean') return `Merges cleanly into ${mainBranch}${behind}`

  const paths = verdict.payload
  if (paths.length === 0) return `Conflicts with ${mainBranch}${behind}`
  const noun = paths.length === 1 ? 'conflict' : 'conflicts'
  const preview = paths.slice(0, CONFLICT_PREVIEW).join(', ')
  const rest = paths.length - CONFLICT_PREVIEW
  const more = rest > 0 ? ` +${rest} more` : ''
  return `${paths.length} ${noun} with ${mainBranch}: ${preview}${more}${behind}`
}

export function mergeReadinessTitle(r: MergeReadiness, mainBranch: string): string | undefined {
  const { verdict } = r
  if (verdict.type !== 'conflicts' || verdict.payload.length === 0) return undefined
  return `Conflicts with ${mainBranch}:\n${verdict.payload.join('\n')}`
}

export function mergeReadinessTone(r: MergeReadiness): MergeTone {
  switch (r.verdict.type) {
    case 'clean':
      return 'ok'
    case 'conflicts':
      return 'warn'
    case 'unknown':
      return 'muted'
  }
}

// No extra git call — the worktree list already names the main branch.
// A detached main worktree has no branch name to merge "into", so fall back
// to the conventional name rather than printing "(detached)" in the footer.
export function mainBranchOf(worktrees: ReadonlyArray<{ isMain: boolean; branch: string }>): string {
  const main = worktrees.find((w) => w.isMain)
  if (!main || main.branch === '(detached)') return 'main'
  return main.branch
}
