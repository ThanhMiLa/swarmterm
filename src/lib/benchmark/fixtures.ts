/**
 * Benchmark fixtures for measuring terminal scrolling and output performance.
 * Development and performance evaluation only.
 */

/**
 * Generate a realistic static log with ANSI color sequences.
 * Simulates build logs, test runners, or container output.
 */
export function generateStaticLog(lineCount: number = 5000): string {
  const lines: string[] = []
  const levels = [
    '\x1b[32mINFO\x1b[0m',
    '\x1b[33mWARN\x1b[0m',
    '\x1b[31mERROR\x1b[0m',
    '\x1b[36mDEBUG\x1b[0m',
    '\x1b[35mTRACE\x1b[0m'
  ]
  const components = ['server', 'database', 'auth', 'bundler', 'watcher', 'pty-session']

  for (let i = 0; i < lineCount; i++) {
    const level = levels[i % levels.length]
    const comp = components[i % components.length]
    const timestamp = new Date(1700000000000 + i * 123).toISOString()
    lines.push(
      `[${timestamp}] [${level}] [${comp}] Line ${i + 1}: processing event ${i.toString(36).padStart(8, '0')} - memory_rss=${(50 + (i % 200) * 0.5).toFixed(1)}MB`
    )
  }
  return lines.join('\r\n') + '\r\n'
}

/**
 * Generate a continuous stream of data chunks simulating heavy output.
 */
export function generateStreamChunks(chunkCount: number = 100, chunkSize: number = 4096): string[] {
  const chunks: string[] = []
  const baseChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 \n\r\t[]()<>'

  for (let c = 0; c < chunkCount; c++) {
    let s = ''
    while (s.length < chunkSize) {
      const idx = (c * 7 + s.length) % (baseChars.length - 10)
      s += baseChars.slice(idx, idx + 10)
    }
    chunks.push(s.slice(0, chunkSize))
  }
  return chunks
}

/**
 * Generate simulated WheelEvent options for benchmark replays.
 * Simulates both trackpad continuous scrolls (small pixel deltas) and
 * physical mouse wheel clicks (line deltas or >= 50-100 px).
 */
export interface WheelReplayStep {
  deltaY: number
  deltaX?: number
  deltaMode: number // 0 = pixel, 1 = line, 2 = page
  altKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  delayMs: number
}

/**
 * Generate a repeatable wheel sequence (e.g. quick flick or smooth trackpad pan).
 */
export function generateWheelReplaySequence(type: 'trackpad-flick' | 'trackpad-slow' | 'mouse-wheel'): WheelReplayStep[] {
  const steps: WheelReplayStep[] = []

  if (type === 'trackpad-flick') {
    // Quick ramp up then decay (pixel mode, deltaMode = 0)
    const deltas = [4, 12, 28, 46, 62, 58, 42, 26, 14, 8, 3, 1]
    for (const d of deltas) {
      steps.push({ deltaY: d, deltaMode: 0, delayMs: 16 })
    }
  } else if (type === 'trackpad-slow') {
    // Small continuous trackpad inputs < 50 (triggers xterm 0.3 heuristic in native)
    for (let i = 0; i < 20; i++) {
      steps.push({ deltaY: 15, deltaMode: 0, delayMs: 16 })
    }
  } else {
    // Physical mouse wheel clicks (line mode, deltaMode = 1 or deltaMode = 0 with deltaY = 100)
    for (let i = 0; i < 10; i++) {
      steps.push({ deltaY: 1, deltaMode: 1, delayMs: 64 })
    }
  }

  return steps
}

/**
 * ANSI sequences to enter and initialize mouse tracking mode in TUI apps (e.g. htop, tmux, nvim).
 * SGR mouse tracking: CSI ? 1000 h (VT200), CSI ? 1002 h (button-event tracking), CSI ? 1006 h (SGR mode)
 */
export const TUI_MOUSE_ENABLE_SGR = '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h'

/**
 * ANSI sequence to leave alternate buffer and disable mouse tracking.
 */
export const TUI_MOUSE_DISABLE = '\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l'
