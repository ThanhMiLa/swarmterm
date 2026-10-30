import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/tauri/git', () => ({
  listWorktrees: vi.fn(),
  getChangedFiles: vi.fn(),
  getFileDiff: vi.fn(),
  getCommitInfo: vi.fn(),
  mergeReadiness: vi.fn()
}))

import { getChangedFiles, getCommitInfo, getFileDiff, listWorktrees, mergeReadiness } from '@/tauri/git'
import type { ChangedFile, CommitInfo, MergeReadiness, WorktreeInfo } from '@/tauri/git'
import { useGitStore } from './git-store'

const MAIN = '/x/myapp'
const ALPHA = '/x/myapp.worktrees/alpha-1'
const trees: WorktreeInfo[] = [
  { path: MAIN, branch: 'main', head: 'aaa', isMain: true },
  { path: ALPHA, branch: 'swarm/claude-code-1', head: 'bbb', isMain: false }
]
const file = (path: string): ChangedFile => ({ path, status: 'M', added: 1, removed: 0 })
const info: CommitInfo = { headSha: 'bbb', branch: 'swarm/claude-code-1', ahead: 1, behind: 0 }
const clean: MergeReadiness = { verdict: { type: 'clean' }, behindMain: 0 }

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const mocked = {
  files: vi.mocked(getChangedFiles),
  info: vi.mocked(getCommitInfo),
  diff: vi.mocked(getFileDiff),
  merge: vi.mocked(mergeReadiness)
}

beforeEach(() => {
  vi.resetAllMocks()
  mocked.diff.mockImplementation(async (_wt, f) => `+new ${f}`)
  mocked.merge.mockResolvedValue(clean)
  useGitStore.setState({
    panelOpen: true,
    mode: 'git',
    currentCwd: ALPHA,
    worktrees: trees,
    selectedWorktreePath: ALPHA,
    worktreeCounts: new Map([[MAIN, 0], [ALPHA, 2]]),
    changedFiles: [file('a.ts'), file('b.ts')],
    commitInfo: info,
    mergeReadiness: clean,
    expandedFiles: new Set(['a.ts', 'b.ts']),
    fileDiffs: new Map([['a.ts', '-old a'], ['b.ts', '-old b']]),
    loading: false,
    error: null
  })
})

describe('refreshSelected', () => {
  it('keeps the current list on screen (no flash) and swaps it when results land, updating the count', async () => {
    const files = deferred<ChangedFile[]>()
    mocked.files.mockReturnValue(files.promise)
    mocked.info.mockResolvedValue({ ...info, ahead: 2 })
    useGitStore.getState().refreshSelected()
    expect(useGitStore.getState().changedFiles).toHaveLength(2)
    expect(useGitStore.getState().loading).toBe(false)
    files.resolve([file('a.ts'), file('c.ts'), file('d.ts')])
    await flush()
    const st = useGitStore.getState()
    expect(st.changedFiles.map((f) => f.path)).toEqual(['a.ts', 'c.ts', 'd.ts'])
    expect(st.commitInfo?.ahead).toBe(2)
    expect(st.worktreeCounts.get(ALPHA)).toBe(3)
    expect(st.worktreeCounts.get(MAIN)).toBe(0)
  })

  it('prunes expanded rows to surviving files and re-fetches only their diffs', async () => {
    mocked.files.mockResolvedValue([file('a.ts'), file('c.ts')])
    mocked.info.mockResolvedValue(info)
    useGitStore.getState().refreshSelected()
    await flush()
    const st = useGitStore.getState()
    expect([...st.expandedFiles]).toEqual(['a.ts'])
    expect(mocked.diff).toHaveBeenCalledTimes(1)
    expect(mocked.diff).toHaveBeenCalledWith(ALPHA, 'a.ts')
    expect(st.fileDiffs.get('a.ts')).toBe('+new a.ts')
    expect(st.fileDiffs.has('b.ts')).toBe(false)
  })

  it('discards results when the selection changed mid-flight', async () => {
    const files = deferred<ChangedFile[]>()
    mocked.files.mockReturnValue(files.promise)
    mocked.info.mockResolvedValue(info)
    useGitStore.getState().refreshSelected()
    useGitStore.setState({ selectedWorktreePath: MAIN, changedFiles: [] })
    files.resolve([file('z.ts')])
    await flush()
    expect(useGitStore.getState().changedFiles).toEqual([])
  })

  it('re-probes merge readiness for a worktree branch, keeping the old verdict until the new one lands', async () => {
    mocked.files.mockResolvedValue([])
    mocked.info.mockResolvedValue(info)
    const probe = deferred<MergeReadiness>()
    mocked.merge.mockReturnValue(probe.promise)
    useGitStore.getState().refreshSelected()
    expect(useGitStore.getState().mergeReadiness).toBe(clean)
    probe.resolve({ verdict: { type: 'conflicts', payload: ['README.md'] }, behindMain: 1 })
    await flush()
    expect(useGitStore.getState().mergeReadiness?.verdict.type).toBe('conflicts')
    expect(mocked.merge).toHaveBeenCalledWith(ALPHA, 'swarm/claude-code-1')
  })

  it('never probes the main worktree', async () => {
    useGitStore.setState({ selectedWorktreePath: MAIN, mergeReadiness: null })
    mocked.files.mockResolvedValue([])
    mocked.info.mockResolvedValue(info)
    useGitStore.getState().refreshSelected()
    await flush()
    expect(mocked.merge).not.toHaveBeenCalled()
    expect(useGitStore.getState().mergeReadiness).toBeNull()
  })

  it('a failed probe clears the stale verdict (fail-open: no footer line)', async () => {
    mocked.files.mockResolvedValue([])
    mocked.info.mockResolvedValue(info)
    mocked.merge.mockRejectedValue(new Error('git too old'))
    useGitStore.getState().refreshSelected()
    await flush()
    expect(useGitStore.getState().mergeReadiness).toBeNull()
  })

  it('is a no-op without a selection', () => {
    useGitStore.setState({ selectedWorktreePath: '' })
    useGitStore.getState().refreshSelected()
    expect(mocked.files).not.toHaveBeenCalled()
  })
})

describe('fetchFileDiff', () => {
  it('two in-flight diff fetches both land (no captured-Map clobber)', async () => {
    useGitStore.setState({ fileDiffs: new Map() })
    const a = deferred<string>()
    const b = deferred<string>()
    mocked.diff.mockImplementation((_wt, f) => (f === 'a.ts' ? a.promise : b.promise))
    void useGitStore.getState().fetchFileDiff('a.ts')
    void useGitStore.getState().fetchFileDiff('b.ts')
    a.resolve('+a')
    b.resolve('+b')
    await flush()
    expect(useGitStore.getState().fileDiffs.get('a.ts')).toBe('+a')
    expect(useGitStore.getState().fileDiffs.get('b.ts')).toBe('+b')
  })
})

describe('opening the Git panel', () => {
  it.each(['togglePanel', 'setMode'] as const)('%s refreshes cached worktrees without clearing the list or selection', async (action) => {
    useGitStore.setState({ panelOpen: false })
    const before = useGitStore.getState()
    const files = deferred<ChangedFile[]>()
    mocked.files.mockReturnValue(files.promise)
    mocked.info.mockResolvedValue(info)

    if (action === 'setMode') before.setMode('git')
    else before.togglePanel()

    const after = useGitStore.getState()
    expect(after.panelOpen).toBe(true)
    expect(after.worktrees).toBe(before.worktrees)
    expect(after.changedFiles).toBe(before.changedFiles)
    expect(after.selectedWorktreePath).toBe(ALPHA)
    expect(after.expandedFiles).toBe(before.expandedFiles)
    expect(after.fileDiffs).toBe(before.fileDiffs)
    expect(after.loading).toBe(false)
    expect(listWorktrees).not.toHaveBeenCalled()
    expect(mocked.files).toHaveBeenCalledTimes(1)
    expect(mocked.files).toHaveBeenCalledWith(ALPHA)

    files.resolve([file('a.ts')])
    await flush()
    expect(useGitStore.getState().changedFiles).toEqual([file('a.ts')])
  })

  it.each(['togglePanel', 'setMode'] as const)('%s fetches worktrees when no cached list exists', async (action) => {
    useGitStore.setState({ panelOpen: false, worktrees: [] })
    vi.mocked(listWorktrees).mockResolvedValue([])

    if (action === 'setMode') useGitStore.getState().setMode('git')
    else useGitStore.getState().togglePanel()

    expect(listWorktrees).toHaveBeenCalledExactlyOnceWith(ALPHA)
    expect(useGitStore.getState().loading).toBe(true)
    await flush()
    expect(useGitStore.getState().loading).toBe(false)
  })

  it('does not fetch on close or when opening a different mode', () => {
    useGitStore.getState().togglePanel()
    useGitStore.getState().setMode('browser')
    useGitStore.getState().setMode('warroom')
    expect(listWorktrees).not.toHaveBeenCalled()
    expect(mocked.files).not.toHaveBeenCalled()
  })
})
