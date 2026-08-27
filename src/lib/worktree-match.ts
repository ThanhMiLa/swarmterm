// Picks the worktree that owns a pane's cwd. The Git panel used a bare
// `cwd.startsWith(t.path)` and always landed on main for agent panes: git lists
// the main worktree first and `<repo>.worktrees/<slug>` BEGINS with `<repo>`,
// so the sibling container matched main before its own entry was ever tried.
// On Windows the same check never matched at all (git prints `C:/…`, the pane
// cwd is `C:\…`) and fell through to trees[0] — main again.

// Normalise ONLY what git and the pane cwd are known to disagree on:
// `\` → `/` (git prints forward slashes on Windows, PathBuf::join / OSC 7 may
// not), the drive-letter case, and one trailing `/` (never for `/` or `c:/`).
// Everything else is compared byte-for-byte: Linux is case-sensitive and the
// provisioned worktree cwd already matches git's realpath'd form exactly, so
// folding more than this would only invent false matches.
function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(out)) out = out[0].toLowerCase() + out.slice(1)
  if (out.length > 1 && out.endsWith('/') && !/^[a-z]:\/$/.test(out)) {
    out = out.slice(0, -1)
  }
  return out
}

// Boundary-aware containment: `/x/myapp2` must NOT be inside `/x/myapp`.
function contains(root: string, cwd: string): boolean {
  // A filesystem root (`/`, `c:/`) keeps its trailing slash, so it already
  // ends on a path boundary.
  if (root.endsWith('/')) return cwd.startsWith(root)
  return cwd === root || cwd.startsWith(root + '/')
}

/**
 * The worktree that STRICTLY owns `cwd` — longest root wins so a nested
 * worktree beats its parent and `<repo>.worktrees/<slug>` beats `<repo>` in
 * any list order — or `undefined` when no root contains it. For callers where
 * "no owner" must mean "not this repo at all": the Git panel's self-refresh
 * must not re-fetch main because an agent in ANOTHER repo finished. The
 * panel's auto-select wants main for that case, hence the two entry points.
 * Returns the ORIGINAL entry: callers select/highlight by verbatim `path`.
 */
export function worktreeOwningCwd<T extends { path: string }>(
  trees: readonly T[],
  cwd: string,
): T | undefined {
  const target = normalizePath(cwd)
  let best: T | undefined
  let bestLen = -1
  for (const t of trees) {
    const root = normalizePath(t.path)
    if (contains(root, target) && root.length > bestLen) {
      best = t
      bestLen = root.length
    }
  }
  return best
}

/**
 * Picks the worktree that OWNS `cwd`. Longest root wins so a nested worktree
 * beats its parent and `<repo>.worktrees/<slug>` beats `<repo>` regardless of
 * the order git listed them in. Falls back to the main worktree — a cwd
 * outside every worktree is a "show me the repo" case, not "show me whichever
 * git listed first" — then to trees[0] so the function stays total.
 * Returns the ORIGINAL entry: callers select/highlight by verbatim `path`.
 */
export function matchWorktreeForCwd<T extends { path: string; isMain: boolean }>(
  trees: readonly T[],
  cwd: string,
): T | undefined {
  return worktreeOwningCwd(trees, cwd) ?? trees.find(t => t.isMain) ?? trees[0]
}
