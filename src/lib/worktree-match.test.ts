import { describe, expect, it } from 'vitest'
import { matchWorktreeForCwd } from '@/lib/worktree-match'

type Wt = { path: string; isMain: boolean }
const wt = (path: string, isMain = false): Wt => ({ path, isMain })

const main = wt('/x/myapp', true)
const alpha = wt('/x/myapp.worktrees/alpha-1')
const trees: Wt[] = [main, alpha]          // git's order: main first
const shuffled: Wt[] = [alpha, main]

describe('matchWorktreeForCwd', () => {
  it('sibling container beats the main root it starts with (the reported bug)', () => {
    expect(matchWorktreeForCwd(trees, '/x/myapp.worktrees/alpha-1')).toBe(alpha)
  })

  it('subdirectory of the worktree still maps to it', () => {
    expect(matchWorktreeForCwd(trees, '/x/myapp.worktrees/alpha-1/src/lib')).toBe(alpha)
  })

  it('main root and its subdirectories map to main', () => {
    expect(matchWorktreeForCwd(trees, '/x/myapp')).toBe(main)
    expect(matchWorktreeForCwd(trees, '/x/myapp/src')).toBe(main)
  })

  it('a prefix without a path boundary is not a match — falls back to isMain, not trees[0]', () => {
    expect(matchWorktreeForCwd(shuffled, '/x/myapp2')).toBe(main)
  })

  it('tolerates a trailing slash on either side', () => {
    expect(matchWorktreeForCwd(trees, '/x/myapp/')).toBe(main)
    const slashMain = wt('/x/myapp/', true)
    expect(matchWorktreeForCwd([slashMain, alpha], '/x/myapp')).toBe(slashMain)
  })

  it('Windows: separators and drive-letter case are normalised', () => {
    const wMain = wt('C:/dev/myapp', true)
    const wAlpha = wt('C:/dev/myapp.worktrees/alpha-1')
    expect(matchWorktreeForCwd([wMain, wAlpha], 'C:\\dev\\myapp.worktrees\\alpha-1')).toBe(wAlpha)
    expect(matchWorktreeForCwd([wMain, wAlpha], 'C:/dev\\myapp.worktrees\\alpha-1')).toBe(wAlpha)
    // Real match, not the fallback: the only main-flagged entry is a decoy on another drive.
    const decoy = wt('D:/other', true)
    const bs = wt('C:\\dev\\myapp')
    expect(matchWorktreeForCwd([decoy, bs], 'c:/dev/myapp')).toBe(bs)
  })

  it('POSIX paths are case-sensitive (no folding)', () => {
    expect(matchWorktreeForCwd(shuffled, '/x/MyApp')).toBe(main)
  })

  it('longest matching root wins regardless of list order', () => {
    const nested = wt('/x/myapp/nested-wt')
    expect(matchWorktreeForCwd([main, nested], '/x/myapp/nested-wt/src')).toBe(nested)
    expect(matchWorktreeForCwd([nested, main], '/x/myapp/nested-wt/src')).toBe(nested)
  })

  it('cwd outside every worktree falls back to isMain; empty list is undefined', () => {
    expect(matchWorktreeForCwd(shuffled, '/')).toBe(main)
    expect(matchWorktreeForCwd([], '/x')).toBeUndefined()
  })

  it('falls back to trees[0] only when nothing is flagged main', () => {
    const a = wt('/a')
    const b = wt('/b')
    expect(matchWorktreeForCwd([a, b], '/zzz')).toBe(a)
  })
})
