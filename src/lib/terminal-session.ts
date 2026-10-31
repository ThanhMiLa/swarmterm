import type {
  CreateTerminalOptions,
  CreateTerminalResult,
  PtyOut
} from '@/tauri/terminal'

export type TerminalStatus =
  | { kind: 'connecting' }
  | { kind: 'running' }
  | { kind: 'error'; message: string }
  | { kind: 'exited'; exitCode: number }

/** Where decoded pty output is pumped (the xterm instance, in production). */
export interface SessionSink {
  write: (data: string, callback?: () => void) => void
  /** One activity notification per PTY message, independent of parser slicing. */
  onOutput?: () => void
}

/** Tauri bridge functions, injected so the session is testable without Tauri. */
export interface SessionDeps {
  createTerminal: (
    id: string,
    options: CreateTerminalOptions,
    onOutput: (msg: PtyOut) => void
  ) => Promise<CreateTerminalResult>
  killTerminal: (id: string) => Promise<void>
  ackTerminalOutput?: (id: string, flowId: number, processedBytes: number) => Promise<void>
}

export const CHUNK_MAX_SIZE = 8192 // 8 KiB maximum chunk size
export const ACK_COALESCE_BYTES = 32 * 1024 // 32 KiB threshold
export const ACK_TIMER_MS = 16 // 16 ms independent timer
const ACK_RETRY_DELAYS_MS = [16, 64, 256] as const

export interface TerminalOutputMetrics {
  receivedMessages: number
  receivedBytes: number
  parsedBytes: number
  pendingBytes: number
  peakPendingBytes: number
  largestChunkBytes: number
}

const encoder = new TextEncoder()

/** encodeInto stops before a code point that would exceed the UTF-8 byte budget. */
export function chunkUtf8Safely(str: string, maxChunkSize = CHUNK_MAX_SIZE): { data: string; byteLen: number }[] {
  if (!Number.isInteger(maxChunkSize) || maxChunkSize < 4) throw new RangeError('UTF-8 chunk budget must be at least 4 bytes')
  const chunks: { data: string; byteLen: number }[] = []
  const buffer = new Uint8Array(maxChunkSize)
  let start = 0
  while (start < str.length) {
    const { read, written } = encoder.encodeInto(str.slice(start), buffer)
    chunks.push({ data: str.slice(start, start + read), byteLen: written })
    start += read
  }
  return chunks
}

/**
 * The pty half of one terminal, decoupled from xterm and React. It spawns the
 * backend pty exactly once and lives until explicitly disposed — so a pane that
 * unmounts/remounts (e.g. when a sibling closes and the split tree collapses)
 * keeps the same running shell instead of killing and re-spawning it.
 */
export class TerminalSession {
  private status: TerminalStatus = { kind: 'connecting' }
  private readonly listeners = new Set<() => void>()
  private started = false
  private disposed = false
  /** Bumped on retry/dispose to drop callbacks from a superseded pty channel. */
  private generation = 0
  /** Options to spawn with once the current (being-killed) pty reports exit. */
  private pendingRespawn: CreateTerminalOptions | null = null
  /** A fatal output error still needs its old reader to finish before ID reuse. */
  private awaitingFailedExit = false
  private cleanupSpawn: (() => void) | undefined
  private metrics: TerminalOutputMetrics = { receivedMessages: 0, receivedBytes: 0, parsedBytes: 0, pendingBytes: 0, peakPendingBytes: 0, largestChunkBytes: 0 }

  getOutputMetrics(): TerminalOutputMetrics { return { ...this.metrics } }

  constructor(
    readonly id: string,
    private readonly sink: SessionSink,
    private readonly deps: SessionDeps
  ) {}

  getStatus(): TerminalStatus {
    return this.status
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(status: TerminalStatus): void {
    this.status = status
    for (const listener of this.listeners) listener()
  }

  /** Spawn the pty. No-op once started, so repeated mounts never re-spawn. */
  start(options: CreateTerminalOptions): void {
    if (this.started || this.disposed) return
    this.started = true
    this.spawn(options)
  }

  /** Re-spawn after an exit or error. Caller should reset the sink first. */
  retry(options: CreateTerminalOptions): void {
    if (this.disposed) return
    if (this.awaitingFailedExit) {
      this.pendingRespawn = options
      this.emit({ kind: 'connecting' })
      const generation = this.generation
      // The bridge may have recovered since the automatic kill failed. Retry
      // stopping this PTY, but never create its replacement before the exit.
      void this.deps.killTerminal(this.id).catch(error => {
        if (this.disposed || generation !== this.generation || !this.awaitingFailedExit) return
        this.pendingRespawn = null
        this.emit({ kind: 'error', message: `Cannot stop terminal: ${error instanceof Error ? error.message : String(error)}` })
      })
      return
    }
    this.generation += 1
    this.started = true
    this.spawn(options)
  }

  /**
   * Restart a running pty with new options (agent / cwd / shell switch). The
   * backend frees a terminal id only once its process exits, and rejects a
   * duplicate live id — so kill the current pty and defer the fresh spawn until
   * its exit is observed (the backend frees the id just before sending it). If
   * the pty isn't currently live, spawn immediately, like retry.
   */
  respawn(options: CreateTerminalOptions): void {
    if (this.disposed) return
    const live =
      this.started && this.status.kind !== 'exited' && this.status.kind !== 'error'
    if (!live) {
      this.retry(options)
      return
    }
    this.pendingRespawn = options
    this.emit({ kind: 'connecting' })
    void this.deps.killTerminal(this.id)
  }

  /** Kill the pty and tear down. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.cleanupSpawn?.()
    if (this.started) void this.deps.killTerminal(this.id)
  }

  private spawn(options: CreateTerminalOptions): void {
    this.cleanupSpawn?.()
    this.metrics = { receivedMessages: 0, receivedBytes: 0, parsedBytes: 0, pendingBytes: 0, peakPendingBytes: 0, largestChunkBytes: 0 }
    const generation = this.generation
    let failed = false
    const fresh = (): boolean => generation === this.generation && !this.disposed && !failed
    let exited = false

    // Flow control state
    let currentFlowId: number | null = null
    let processedBytes = 0
    let lastAckedBytes = 0
    let pendingWrites = 0
    let ackTimer: ReturnType<typeof setTimeout> | null = null
    let ackRetryTimer: ReturnType<typeof setTimeout> | null = null
    let ackInFlight = false
    let ackFailures = 0
    let ackActive = true
    let pendingExitCode: number | null = null
    this.cleanupSpawn = () => {
      if (ackTimer !== null) clearTimeout(ackTimer)
      if (ackRetryTimer !== null) clearTimeout(ackRetryTimer)
      ackTimer = null
      ackRetryTimer = null
      ackActive = false
    }

    const scheduleAck = () => {
      if (!this.deps.ackTerminalOutput || !ackActive || !fresh() || currentFlowId === null ||
        processedBytes <= lastAckedBytes || ackInFlight || ackRetryTimer !== null || ackTimer !== null) return
      // Independent of animation frames so background panes return credit too.
      ackTimer = setTimeout(() => { ackTimer = null; flushAck() }, ACK_TIMER_MS)
    }

    const flushAck = () => {
      if (ackTimer !== null) {
        clearTimeout(ackTimer)
        ackTimer = null
      }
      const sendAck = this.deps.ackTerminalOutput
      if (!sendAck || !ackActive || !fresh() || currentFlowId === null ||
        processedBytes <= lastAckedBytes || ackInFlight || ackRetryTimer !== null) return
      const bytes = processedBytes
      ackInFlight = true
      const success = () => {
        if (!ackActive || !fresh()) return
        ackInFlight = false
        // A submitted ACK is not yet confirmed. Only successful IPC returns
        // credit; retry cumulative parsed bytes if the previous request failed.
        lastAckedBytes = bytes
        ackFailures = 0
        if (processedBytes - lastAckedBytes >= ACK_COALESCE_BYTES) flushAck()
        else scheduleAck()
      }
      const failure = (error: unknown) => {
        if (!ackActive || !fresh()) return
        ackInFlight = false
        const delay = ACK_RETRY_DELAYS_MS[ackFailures++]
        if (delay !== undefined) {
          ackRetryTimer = setTimeout(() => { ackRetryTimer = null; flushAck() }, delay)
          return
        }
        // A permanently broken bridge must not leave a frozen "running" pane
        // with a full credit window. Preserve its output and expose normal Retry.
        failed = true
        this.awaitingFailedExit = true
        this.pendingRespawn = null
        this.cleanupSpawn?.()
        const detail = error instanceof Error ? error.message : String(error)
        this.emit({ kind: 'error', message: `Cannot acknowledge terminal output: ${detail}` })
        void this.deps.killTerminal(this.id).catch(console.warn)
      }
      try { void sendAck(this.id, currentFlowId, bytes).then(success, failure) }
      catch (error) { failure(error) }
    }

    const finishExit = (code: number) => {
      exited = true
      this.awaitingFailedExit = false
      this.cleanupSpawn?.()
      if (this.pendingRespawn) {
        const next = this.pendingRespawn
        this.pendingRespawn = null
        this.retry(next)
      } else {
        this.emit({ kind: 'exited', exitCode: code })
      }
    }

    this.emit({ kind: 'connecting' })

    this.deps
      .createTerminal(this.id, options, (msg) => {
        if (generation !== this.generation || this.disposed) return
        if (failed && msg.type === 'exit') {
          this.awaitingFailedExit = false
          if (this.pendingRespawn) {
            const next = this.pendingRespawn
            this.pendingRespawn = null
            this.retry(next)
          }
          return // preserve the error unless the user explicitly requested Retry
        }
        if (!fresh()) return
        if (msg.type === 'data') {
          const { flowId, data, byteLen } =
            typeof msg.payload === 'string'
              ? { flowId: 0, data: msg.payload, byteLen: undefined }
              : {
                  flowId: msg.payload.flowId,
                  data: msg.payload.data,
                  byteLen: msg.payload.byteLen
                }

          if (flowId !== 0) {
            if (currentFlowId !== null && flowId !== currentFlowId) return
            currentFlowId = flowId
          }

          // Rust already counts the decoded UTF-8 bytes. Most PTY messages fit
          // in one slice: avoid allocating/encoding another 8 KiB buffer for each.
          const chunks = byteLen !== undefined && byteLen >= data.length && byteLen <= CHUNK_MAX_SIZE
            ? [{ data, byteLen }]
            : chunkUtf8Safely(data, CHUNK_MAX_SIZE)
          this.metrics.receivedMessages++
          this.sink.onOutput?.()
          this.metrics.receivedBytes += chunks.reduce((sum, chunk) => sum + chunk.byteLen, 0)
          this.metrics.pendingBytes = this.metrics.receivedBytes - this.metrics.parsedBytes
          this.metrics.peakPendingBytes = Math.max(this.metrics.peakPendingBytes, this.metrics.pendingBytes)

          for (const chunk of chunks) {
            this.metrics.largestChunkBytes = Math.max(this.metrics.largestChunkBytes, chunk.byteLen)
            pendingWrites++
            this.sink.write(chunk.data, () => {
              if (!fresh()) return
              pendingWrites--
              processedBytes += chunk.byteLen
              this.metrics.parsedBytes += chunk.byteLen
              this.metrics.pendingBytes = this.metrics.receivedBytes - this.metrics.parsedBytes

              const unacked = processedBytes - lastAckedBytes
              if (unacked >= ACK_COALESCE_BYTES) {
                flushAck()
              } else scheduleAck()

              // If an exit arrived while writes were in-flight, finish exit now
              if (pendingWrites === 0 && pendingExitCode !== null) {
                flushAck()
                finishExit(pendingExitCode)
              }
            })
          }
        } else {
          // Exit event received: wait until all pending writes have finished
          const exitCode = msg.payload.exitCode
          if (pendingWrites > 0) {
            pendingExitCode = exitCode
          } else {
            flushAck()
            finishExit(exitCode)
          }
        }
      })
      .then((result) => {
        if (!fresh()) return
        if (!result.ok) this.emit({ kind: 'error', message: result.error ?? 'Unknown error' })
        else if (!exited) this.emit({ kind: 'running' })
      })
      .catch((err: unknown) => {
        if (!fresh()) return
        this.emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      })
  }
}
