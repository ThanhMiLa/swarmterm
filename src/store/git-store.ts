// src/store/git-store.ts
import { create } from 'zustand'
import {
  listWorktrees,
  getChangedFiles,
  getFileDiff,
  getCommitInfo,
  mergeReadiness,
  type WorktreeInfo,
  type ChangedFile,
  type CommitInfo,
  type MergeReadiness,
} from '@/tauri/git'
import { matchWorktreeForCwd } from '@/lib/worktree-match'

export type { WorktreeInfo, ChangedFile, CommitInfo, MergeReadiness }

interface GitStore {
  panelOpen: boolean
  mode: 'browser' | 'git' | 'warroom'
  currentCwd: string
  worktrees: WorktreeInfo[]
  selectedWorktreePath: string
  /** Changed-file count per worktree path. Undefined while still loading that worktree. */
  worktreeCounts: Map<string, number>
  changedFiles: ChangedFile[]
  commitInfo: CommitInfo | null
  /** Null for the main worktree (never probed) and on any probe error (fail-open: no footer line). */
  mergeReadiness: MergeReadiness | null
  expandedFiles: Set<string>
  fileDiffs: Map<string, string>
  loading: boolean
  error: string | null

  setMode: (mode: 'browser' | 'git' | 'warroom') => void
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
  selectWorktree: (path: string) => void
  toggleFileExpand: (filePath: string) => void
  fetchWorktrees: (cwd: string) => Promise<void>
  fetchFileDiff: (filePath: string) => Promise<void>
  refresh: () => void
}

export const useGitStore = create<GitStore>((set, get) => ({
  panelOpen: false,
  mode: 'browser',
  currentCwd: '',
  worktrees: [],
  selectedWorktreePath: '',
  worktreeCounts: new Map(),
  changedFiles: [],
  commitInfo: null,
  mergeReadiness: null,
  expandedFiles: new Set(),
  fileDiffs: new Map(),
  loading: false,
  error: null,

  setMode: (mode) => {
    // Picking a tab always reveals the panel (the tabs live inside it).
    set({ mode, panelOpen: true })
    if (mode === 'git') {
      const { currentCwd } = get()
      if (currentCwd) void get().fetchWorktrees(currentCwd)
    }
  },

  setPanelOpen: (open) => set({ panelOpen: open }),

  togglePanel: () => {
    const open = !get().panelOpen
    set({ panelOpen: open })
    // Opening into Git mode triggers a fresh fetch for the focused terminal.
    if (open && get().mode === 'git') {
      const { currentCwd } = get()
      if (currentCwd) void get().fetchWorktrees(currentCwd)
    }
  },

  selectWorktree: (path) => {
    set({
      selectedWorktreePath: path,
      changedFiles: [],
      commitInfo: null,
      mergeReadiness: null,
      expandedFiles: new Set(),
      fileDiffs: new Map(),
      loading: true,
      error: null,
    })
    void (async () => {
      try {
        const [files, info] = await Promise.all([
          getChangedFiles(path),
          getCommitInfo(path),
        ])
        if (get().selectedWorktreePath !== path) return  // selection changed — discard stale results
        set({ changedFiles: files, commitInfo: info, loading: false })
      } catch (e) {
        set({ error: String(e), loading: false })
      }
    })()
    // Merge probe rides its own promise: `git merge-tree` can be slower than the
    // file list and must never delay it. Main worktree ⇒ never asked (self-merge).
    // Passing the worktree path as repoRoot is fine — the Rust side resolves the
    // main root through `--git-common-dir`, so the probe still runs at main's HEAD.
    const wt = get().worktrees.find((t) => t.path === path)
    if (wt && !wt.isMain && wt.branch !== '(detached)') {
      void mergeReadiness(path, wt.branch)
        .then((r) => {
          if (get().selectedWorktreePath === path) set({ mergeReadiness: r })
        })
        .catch(() => { /* fail-open: no footer line */ })
    }
  },

  toggleFileExpand: (filePath) => {
    const { expandedFiles } = get()
    const next = new Set(expandedFiles)
    if (next.has(filePath)) {
      next.delete(filePath)
      set({ expandedFiles: next })
    } else {
      next.add(filePath)
      set({ expandedFiles: next })
      if (!get().fileDiffs.has(filePath)) {
        void get().fetchFileDiff(filePath)
      }
    }
  },

  fetchWorktrees: async (cwd) => {
    set({
      loading: true,
      error: null,
      currentCwd: cwd,
      worktrees: [],
      worktreeCounts: new Map(),
      changedFiles: [],
      commitInfo: null,
      mergeReadiness: null,
      expandedFiles: new Set(),
      fileDiffs: new Map(),
    })
    try {
      const trees = await listWorktrees(cwd)
      if (get().currentCwd !== cwd) return  // another fetch started — discard stale results
      if (trees.length === 0) {
        set({ worktrees: [], loading: false })
        return
      }
      // Auto-select the worktree that owns cwd. Not a bare startsWith: git lists
      // main first and `<repo>.worktrees/<slug>` begins with `<repo>`, so agent
      // panes used to land on main (and Windows `C:\` vs `C:/` never matched).
      const match = matchWorktreeForCwd(trees, cwd) ?? trees[0]
      set({ worktrees: trees, loading: false })
      get().selectWorktree(match.path)
      // Fill per-worktree change counts in parallel (best-effort, non-blocking).
      // Each result is merged as it arrives so the list updates progressively.
      for (const wt of trees) {
        void getChangedFiles(wt.path)
          .then((files) => {
            if (get().currentCwd !== cwd) return  // stale — a newer fetch is in flight
            const next = new Map(get().worktreeCounts)
            next.set(wt.path, files.length)
            set({ worktreeCounts: next })
          })
          .catch(() => { /* leave count undefined on failure */ })
      }
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  fetchFileDiff: async (filePath) => {
    const { selectedWorktreePath, fileDiffs } = get()
    if (!selectedWorktreePath) return
    try {
      const diff = await getFileDiff(selectedWorktreePath, filePath)
      const next = new Map(fileDiffs)
      next.set(filePath, diff)
      set({ fileDiffs: next })
    } catch {
      // Silently ignore — InlineDiff renders "No diff available" for empty string.
    }
  },

  refresh: () => {
    const { currentCwd } = get()
    if (currentCwd) void get().fetchWorktrees(currentCwd)
  },
}))
