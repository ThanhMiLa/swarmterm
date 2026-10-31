import { invoke, Channel } from '@tauri-apps/api/core'
import type { ShellId } from '@/lib/terminal-pref'
import { TerminalWriteQueue } from '@/lib/terminal-write-queue'

const inputQueue = new TerminalWriteQueue()
const inputTokens = new Map<string, string>()

/** Output streamed from a pty: decoded text with flow control metadata, then a final exit. */
export type PtyData = {
  flowId: number
  data: string
  byteLen: number
}

export type PtyExit = {
  flowId: number
  exitCode: number
}

export type PtyOut =
  | { type: 'data'; payload: string | PtyData }
  | { type: 'exit'; payload: { exitCode: number; flowId?: number } }

export interface CreateTerminalOptions {
  /** Available only in the isolated debug benchmark process. */
  benchmarkFixture?: 'static' | 'stream' | 'tui' | 'tui-stream'
  cwd?: string
  shellId?: ShellId
  initialCommand?: string
  worktreeMode?: boolean
  repoRoot?: string
  cols: number
  rows: number
}

export interface CreateTerminalResult {
  ok: boolean
  pid?: number
  shell?: string
  error?: string
}

/** Spawn a pty; `onOutput` receives every data chunk and the final exit. */
export function createTerminal(
  id: string,
  options: CreateTerminalOptions,
  onOutput: (msg: PtyOut) => void
): Promise<CreateTerminalResult> {
  const inputToken = crypto.randomUUID()
  inputTokens.set(id, inputToken)
  const onData = new Channel<PtyOut>()
  onData.onmessage = onOutput
  return invoke<CreateTerminalResult>('create_terminal', { id, options: { ...options, inputToken }, onData })
}

export const writeTerminal = (id: string, data: string): Promise<void> => {
  const inputToken = inputTokens.get(id)
  return inputQueue.write(id, () => invoke('write_terminal', { id, data, inputToken }))
}

export const writeTerminalBytes = (
  id: string,
  bytes: number[] | Uint8Array
): Promise<void> => {
  const inputToken = inputTokens.get(id)
  const payload = Array.from(bytes)
  return inputQueue.write(id, () => invoke('write_terminal_bytes', { id, bytes: payload, inputToken }))
}

export const ackTerminalOutput = (
  id: string,
  flowId: number,
  processedBytes: number
): Promise<void> => invoke('ack_terminal_output', { id, flowId, processedBytes })

export const resizeTerminal = (id: string, cols: number, rows: number): Promise<void> =>
  invoke('resize_terminal', { id, cols, rows })

export const killTerminal = (id: string): Promise<void> => {
  inputQueue.cancel(id)
  inputTokens.delete(id)
  return invoke('kill_terminal', { id })
}
