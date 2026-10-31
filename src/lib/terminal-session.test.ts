import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtyOut } from '@/tauri/terminal'
import { TerminalSession, chunkUtf8Safely, type SessionDeps } from '@/lib/terminal-session'

/** A fresh set of mocked tauri deps; createTerminal resolves ok by default. */
function makeDeps(): SessionDeps & {
  /** Push a pty message into the latest createTerminal channel. */
  emit: (msg: PtyOut) => void
  /** Every createTerminal channel, in call order, for targeting old generations. */
  channels: ((msg: PtyOut) => void)[]
} {
  const channels: ((msg: PtyOut) => void)[] = []
  const createTerminal = vi.fn(
    (_id: string, _options, cb: (msg: PtyOut) => void) => {
      channels.push(cb)
      return Promise.resolve({ ok: true, pid: 1, shell: 'sh' })
    }
  )
  const killTerminal = vi.fn(() => Promise.resolve())
  return {
    createTerminal: createTerminal as SessionDeps['createTerminal'],
    killTerminal: killTerminal as SessionDeps['killTerminal'],
    channels,
    emit: (msg) => channels[channels.length - 1]?.(msg)
  }
}

const OPTS = { cols: 80, rows: 24, cwd: '/tmp' }

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('TerminalSession', () => {
  it('spawns the pty only once across repeated start() calls (remounts)', () => {
    const deps = makeDeps()
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)

    session.start(OPTS)
    session.start(OPTS) // detach + re-attach from a tree-collapse remount
    session.start(OPTS)

    expect(deps.createTerminal).toHaveBeenCalledTimes(1)
    expect(deps.killTerminal).not.toHaveBeenCalled()
  })

  it('routes pty data into the sink', () => {
    const deps = makeDeps()
    const write = vi.fn()
    const session = new TerminalSession('t1', { write }, deps)

    session.start(OPTS)
    deps.emit({ type: 'data', payload: 'hello' })

    expect(write).toHaveBeenCalledWith('hello', expect.any(Function))
  })

  it('kills the pty exactly once on dispose, even if called twice', () => {
    const deps = makeDeps()
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)

    session.start(OPTS)
    session.dispose()
    session.dispose()

    expect(deps.killTerminal).toHaveBeenCalledTimes(1)
  })

  it('does not kill a session that never started', () => {
    const deps = makeDeps()
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)

    session.dispose()

    expect(deps.killTerminal).not.toHaveBeenCalled()
  })

  it('does not start again after dispose', () => {
    const deps = makeDeps()
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)

    session.start(OPTS)
    session.dispose()
    session.start(OPTS)

    expect(deps.createTerminal).toHaveBeenCalledTimes(1)
  })

  it('re-spawns the pty on retry after the process exits', () => {
    const deps = makeDeps()
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)

    session.start(OPTS)
    deps.emit({ type: 'exit', payload: { exitCode: 0 } })
    expect(session.getStatus()).toEqual({ kind: 'exited', exitCode: 0 })

    session.retry(OPTS)

    expect(deps.createTerminal).toHaveBeenCalledTimes(2)
    expect(session.getStatus()).toEqual({ kind: 'connecting' })
  })

  it('ignores pty messages from a superseded generation after retry', () => {
    const deps = makeDeps()
    const write = vi.fn()
    const session = new TerminalSession('t1', { write }, deps)

    session.start(OPTS)
    const staleChannel = deps.channels[0]
    deps.emit({ type: 'exit', payload: { exitCode: 1 } })
    session.retry(OPTS)

    // A late message from the OLD pty channel must not reach the sink.
    staleChannel({ type: 'data', payload: 'ghost' })
    expect(write).not.toHaveBeenCalledWith('ghost')
  })

  it('kills a running pty and re-spawns only after its exit is observed', () => {
    const deps = makeDeps()
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)

    session.start(OPTS)
    expect(deps.createTerminal).toHaveBeenCalledTimes(1)

    // Switch on a LIVE pty: must kill, but must NOT spawn yet (backend id still live).
    session.respawn({ ...OPTS, cwd: '/other' })
    expect(deps.killTerminal).toHaveBeenCalledTimes(1)
    expect(deps.createTerminal).toHaveBeenCalledTimes(1)
    expect(session.getStatus()).toEqual({ kind: 'connecting' })

    // The dying pty reports exit (backend has now freed the id) -> fresh spawn.
    deps.emit({ type: 'exit', payload: { exitCode: 0 } })
    expect(deps.createTerminal).toHaveBeenCalledTimes(2)
    expect(session.getStatus()).toEqual({ kind: 'connecting' })
  })

  it('respawns immediately, without a kill, when the pty already exited', () => {
    const deps = makeDeps()
    const session = new TerminalSession('t1', { write: vi.fn() }, deps)

    session.start(OPTS)
    deps.emit({ type: 'exit', payload: { exitCode: 0 } })
    expect(session.getStatus()).toEqual({ kind: 'exited', exitCode: 0 })

    session.respawn(OPTS)
    expect(deps.killTerminal).not.toHaveBeenCalled()
    expect(deps.createTerminal).toHaveBeenCalledTimes(2)
  })

  it('chunks output into <= 8 KiB without cutting surrogate pairs', () => {
    const deps = makeDeps()
    const chunksWritten: string[] = []
    const session = new TerminalSession(
      't1',
      {
        write: (chunk, cb) => {
          chunksWritten.push(chunk)
          cb?.()
        }
      },
      deps
    )

    session.start(OPTS)

    // Construct a 10,000 char string with an emoji (surrogate pair) right at 8191
    const prefix = 'A'.repeat(8191)
    const emoji = '🚀' // length 2 (high surrogate at 8191, low surrogate at 8192)
    const suffix = 'B'.repeat(1000)
    const largeStr = prefix + emoji + suffix

    deps.emit({
      type: 'data',
      payload: { flowId: 1, data: largeStr, byteLen: largeStr.length }
    })

    expect(chunksWritten.length).toBe(2)
    // Chunk 0 must end BEFORE the high surrogate, so it has 8191 chars
    expect(chunksWritten[0].length).toBe(8191)
    // Chunk 1 starts with the intact emoji 🚀
    expect(chunksWritten[1].startsWith('🚀')).toBe(true)
    expect(chunksWritten.join('')).toBe(largeStr)
  })

  it('aggregates ACKs and flushes when reaching 32 KiB threshold', async () => {
    vi.useFakeTimers()
    const ackTerminalOutput = vi.fn(() => Promise.resolve())
    const deps = { ...makeDeps(), ackTerminalOutput }
    const session = new TerminalSession(
      't1',
      {
        write: (_chunk, cb) => {
          cb?.()
        }
      },
      deps
    )

    session.start(OPTS)

    // Emit 40 KiB of data with flowId 42
    deps.emit({
      type: 'data',
      payload: { flowId: 42, data: 'X'.repeat(40 * 1024), byteLen: 40 * 1024 }
    })

    // 32 KiB threshold triggered immediate ACK with 32768 bytes
    expect(ackTerminalOutput).toHaveBeenCalledWith('t1', 42, 32 * 1024)

    // Advance 16ms timer -> remaining 8 KiB (total 40960 bytes) is flushed
    await vi.advanceTimersByTimeAsync(16)
    expect(ackTerminalOutput).toHaveBeenCalledWith('t1', 42, 40 * 1024)
    vi.useRealTimers()
  })

  it('holds exit until all in-flight output writes have completed parsing', async () => {
    const deps = makeDeps()
    let onParsed: (() => void) | undefined
    const session = new TerminalSession(
      't1',
      {
        write: (_chunk, cb) => {
          onParsed = cb
        }
      },
      deps
    )

    session.start(OPTS)
    // Wait for createTerminal promise to resolve to 'running'
    await Promise.resolve()
    expect(session.getStatus().kind).toBe('running')

    // Emit data chunk
    deps.emit({
      type: 'data',
      payload: { flowId: 10, data: 'final output', byteLen: 12 }
    })

    // Now emit exit before the write callback finishes
    deps.emit({
      type: 'exit',
      payload: { flowId: 10, exitCode: 0 }
    })

    // Status must NOT be exited yet because write is still in-flight
    expect(session.getStatus().kind).toBe('running')

    // Parser finishes write callback
    onParsed?.()

    // Now exit is observed
    expect(session.getStatus()).toEqual({ kind: 'exited', exitCode: 0 })
  })
  it('bounds chunks by UTF-8 bytes for Vietnamese, CJK and emoji', () => {
    const data = 'Tiếng Việt 中🚀'.repeat(3000)
    const chunks = chunkUtf8Safely(data)
    expect(chunks.map(c => c.data).join('')).toBe(data)
    for (const chunk of chunks) {
      expect(chunk.byteLen).toBeLessThanOrEqual(8192)
      expect(chunk.byteLen).toBe(new TextEncoder().encode(chunk.data).length)
      expect(chunk.data).not.toMatch(/[\uD800-\uDBFF]$/u)
    }
  })

  it('notifies activity once per message while preserving every parser slice', () => {
    const deps = makeDeps()
    const write = vi.fn((_data: string, cb?: () => void) => cb?.())
    const onOutput = vi.fn()
    const session = new TerminalSession('t1', { write, onOutput }, deps)
    session.start(OPTS)
    const data = '中'.repeat(8192)
    deps.emit({ type: 'data', payload: { flowId: 7, data, byteLen: 24576 } })
    expect(onOutput).toHaveBeenCalledOnce()
    expect(write.mock.calls.map(([chunk]) => chunk).join('')).toBe(data)
    expect(write.mock.calls.length).toBeGreaterThan(1)
    session.dispose()
  })

  it('ACKs only the actual UTF-8 bytes parsed, including uneven chunks', async () => {
    vi.useFakeTimers()
    try {
      const ackTerminalOutput = vi.fn(async () => {})
      const deps = { ...makeDeps(), ackTerminalOutput }
      const callbacks: (() => void)[] = []
      const session = new TerminalSession('t1', { write: (_data, cb) => { callbacks.push(cb!) } }, deps)
      session.start(OPTS)
      const data = 'a'.repeat(8192) + '中'.repeat(8192)
      deps.emit({ type: 'data', payload: { flowId: 7, data, byteLen: 32768 } })
      callbacks.shift()!()
      await vi.advanceTimersByTimeAsync(16)
      expect(ackTerminalOutput).toHaveBeenLastCalledWith('t1', 7, 8192)
      while (callbacks.length) callbacks.shift()!()
      await vi.advanceTimersByTimeAsync(16)
      expect(ackTerminalOutput).toHaveBeenLastCalledWith('t1', 7, 32768)
      session.dispose()
    } finally { vi.useRealTimers() }
  })

  it('cancels ACK timers and ignores stale parser callbacks on dispose', () => {
    vi.useFakeTimers()
    try {
      const ackTerminalOutput = vi.fn(async () => {})
      const deps = { ...makeDeps(), ackTerminalOutput }
      let onParsed!: () => void
      const session = new TerminalSession('t1', { write: (_data, cb) => { onParsed = cb! } }, deps)
      session.start(OPTS)
      deps.emit({ type: 'data', payload: { flowId: 7, data: 'hello', byteLen: 5 } })
      onParsed()
      session.dispose()
      vi.advanceTimersByTime(100)
      expect(ackTerminalOutput).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('retries a failed ACK with all parsed bytes, releasing a full output window without more output', async () => {
    vi.useFakeTimers()
    const ackTerminalOutput = vi.fn(async () => {}).mockRejectedValueOnce(new Error('temporary IPC failure'))
    const deps = { ...makeDeps(), ackTerminalOutput }
    const session = new TerminalSession('t1', { write: (_data, cb) => cb?.() }, deps)
    session.start(OPTS)
    deps.emit({ type: 'data', payload: { flowId: 42, data: 'x'.repeat(256 * 1024), byteLen: 256 * 1024 } })
    expect(ackTerminalOutput).toHaveBeenCalledTimes(1)
    expect(ackTerminalOutput).toHaveBeenLastCalledWith('t1', 42, 32768)
    await vi.advanceTimersByTimeAsync(15)
    expect(ackTerminalOutput).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(ackTerminalOutput).toHaveBeenCalledTimes(2)
    expect(ackTerminalOutput).toHaveBeenLastCalledWith('t1', 42, 256 * 1024)
    expect(session.getStatus().kind).toBe('running')
    expect(deps.killTerminal).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    session.dispose()
  })

  it('allows one ACK in flight and coalesces newer parsed output after confirmation', async () => {
    vi.useFakeTimers()
    let confirm!: () => void
    const ackTerminalOutput = vi.fn(() => new Promise<void>(resolve => { confirm = resolve }))
    const deps = { ...makeDeps(), ackTerminalOutput }
    const session = new TerminalSession('t1', { write: (_data, cb) => cb?.() }, deps)
    session.start(OPTS)
    deps.emit({ type: 'data', payload: { flowId: 42, data: 'x'.repeat(256 * 1024), byteLen: 256 * 1024 } })
    await vi.advanceTimersByTimeAsync(100)
    expect(ackTerminalOutput).toHaveBeenCalledTimes(1)
    confirm()
    await Promise.resolve()
    expect(ackTerminalOutput).toHaveBeenCalledTimes(2)
    expect(ackTerminalOutput).toHaveBeenLastCalledWith('t1', 42, 256 * 1024)
    confirm()
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
    session.dispose()
  })

  it.each(['rejection', 'synchronous throw'] as const)('bounds ACK retries after %s and exposes a retriable error instead of a frozen running pane', async failure => {
    vi.useFakeTimers()
    const ackTerminalOutput = vi.fn(() => {
      const error = new Error('bridge unavailable')
      if (failure === 'synchronous throw') throw error
      return Promise.reject(error)
    })
    const deps = { ...makeDeps(), ackTerminalOutput }
    const write = vi.fn((_data: string, cb?: () => void) => cb?.())
    const session = new TerminalSession('t1', { write }, deps)
    session.start(OPTS)
    deps.emit({ type: 'data', payload: { flowId: 42, data: 'x'.repeat(32768), byteLen: 32768 } })
    await vi.advanceTimersByTimeAsync(16 + 64 + 256)
    expect(ackTerminalOutput).toHaveBeenCalledTimes(4)
    expect(deps.killTerminal).toHaveBeenCalledOnce()
    expect(session.getStatus()).toEqual({ kind: 'error', message: 'Cannot acknowledge terminal output: bridge unavailable' })
    const writesBeforeFailure = write.mock.calls.length
    deps.emit({ type: 'data', payload: { flowId: 42, data: 'late', byteLen: 4 } })
    deps.emit({ type: 'exit', payload: { flowId: 42, exitCode: 1 } })
    await vi.advanceTimersByTimeAsync(10000)
    expect(ackTerminalOutput).toHaveBeenCalledTimes(4)
    expect(write).toHaveBeenCalledTimes(writesBeforeFailure)
    expect(session.getStatus().kind).toBe('error')
    expect(vi.getTimerCount()).toBe(0)
    session.retry(OPTS)
    await Promise.resolve()
    expect(session.getStatus().kind).toBe('running')
    session.dispose()
  })

  it('cancels a scheduled ACK retry on dispose', async () => {
    vi.useFakeTimers()
    const ackTerminalOutput = vi.fn(async () => { throw new Error('temporary failure') })
    const deps = { ...makeDeps(), ackTerminalOutput }
    const session = new TerminalSession('t1', { write: (_data, cb) => cb?.() }, deps)
    session.start(OPTS)
    deps.emit({ type: 'data', payload: { flowId: 42, data: 'x'.repeat(32768), byteLen: 32768 } })
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(1)
    session.dispose()
    await vi.advanceTimersByTimeAsync(10000)
    expect(ackTerminalOutput).toHaveBeenCalledOnce()
    expect(deps.killTerminal).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('defers Retry after a fatal ACK error until the old PTY exits', async () => {
    vi.useFakeTimers()
    const ackTerminalOutput = vi.fn(async () => { throw new Error('bridge unavailable') })
    const deps = { ...makeDeps(), ackTerminalOutput }
    const session = new TerminalSession('t1', { write: (_data, cb) => cb?.() }, deps)
    session.start(OPTS)
    deps.emit({ type: 'data', payload: { flowId: 42, data: 'x'.repeat(32768), byteLen: 32768 } })
    await vi.advanceTimersByTimeAsync(336)
    expect(session.getStatus().kind).toBe('error')
    session.retry({ ...OPTS, cwd: '/replacement' })
    expect(session.getStatus().kind).toBe('connecting')
    expect(deps.createTerminal).toHaveBeenCalledOnce()
    deps.emit({ type: 'exit', payload: { flowId: 42, exitCode: 1 } })
    expect(deps.createTerminal).toHaveBeenCalledTimes(2)
    expect(deps.createTerminal).toHaveBeenLastCalledWith('t1', { ...OPTS, cwd: '/replacement' }, expect.any(Function))
    await Promise.resolve()
    expect(session.getStatus().kind).toBe('running')
    session.dispose()
  })

  it('lets the user retry stopping a failed PTY when the bridge initially rejects kill', async () => {
    vi.useFakeTimers()
    const ackTerminalOutput = vi.fn(async () => { throw new Error('ACK unavailable') })
    const deps = { ...makeDeps(), ackTerminalOutput }
    const session = new TerminalSession('t1', { write: (_data, cb) => cb?.() }, deps)
    session.start(OPTS)
    deps.emit({ type: 'data', payload: { flowId: 42, data: 'x'.repeat(32768), byteLen: 32768 } })
    await vi.advanceTimersByTimeAsync(336)
    vi.mocked(deps.killTerminal).mockRejectedValueOnce(new Error('kill unavailable'))
    session.retry(OPTS)
    await Promise.resolve()
    expect(session.getStatus()).toEqual({ kind: 'error', message: 'Cannot stop terminal: kill unavailable' })
    expect(deps.createTerminal).toHaveBeenCalledOnce()
    session.retry(OPTS)
    deps.emit({ type: 'exit', payload: { flowId: 42, exitCode: 1 } })
    await Promise.resolve()
    expect(deps.createTerminal).toHaveBeenCalledTimes(2)
    expect(session.getStatus().kind).toBe('running')
    session.dispose()
  })

  it('ignores a stale ACK rejection after respawn and after normal exit', async () => {
    vi.useFakeTimers()
    let rejectOld!: (error: Error) => void
    const ackTerminalOutput = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectOld = reject }))
    const deps = { ...makeDeps(), ackTerminalOutput }
    const session = new TerminalSession('t1', { write: (_data, cb) => cb?.() }, deps)
    session.start(OPTS)
    deps.emit({ type: 'data', payload: { flowId: 42, data: 'x'.repeat(32768), byteLen: 32768 } })
    const rejectFirst = rejectOld
    session.respawn(OPTS)
    deps.emit({ type: 'exit', payload: { flowId: 42, exitCode: 0 } })
    rejectFirst(new Error('old session'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(session.getStatus().kind).toBe('running')
    expect(ackTerminalOutput).toHaveBeenCalledOnce()
    deps.emit({ type: 'data', payload: { flowId: 43, data: 'final', byteLen: 5 } })
    deps.emit({ type: 'exit', payload: { flowId: 43, exitCode: 0 } })
    rejectOld(new Error('exited session'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(session.getStatus()).toEqual({ kind: 'exited', exitCode: 0 })
    expect(deps.killTerminal).toHaveBeenCalledOnce() // respawn only
    expect(ackTerminalOutput).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

})
