import type { Terminal, IDisposable } from '@xterm/xterm'
import type { TerminalScrollingPref } from './terminal-scrolling'
import { xtermCore, type XtermMouseEvent } from './terminal-xterm'

export interface WheelEventLike {
  deltaY: number; deltaX?: number; deltaMode: number
  shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean
  clientX?: number; clientY?: number
}

export function normalizeWheelDelta(
  event: WheelEventLike, cellHeight: number, viewportRows: number,
  sensitivity: number, remainder = 0, enhanced = true, fastSensitivity = 5
): { lines: number; remainder: number } {
  if (!Number.isFinite(event.deltaY)) return { lines: 0, remainder }
  let delta = event.deltaY
  if (event.deltaMode === 0) {
    delta /= Math.max(1, cellHeight)
    if (!enhanced && Math.abs(event.deltaY) < 50) delta *= 0.3
  } else if (event.deltaMode === 2) delta *= Math.max(1, viewportRows)
  else if (event.deltaMode !== 1) return { lines: 0, remainder }
  const fast = event.altKey || event.ctrlKey || event.shiftKey ? fastSensitivity : 1
  const total = delta * sensitivity * fast + remainder
  if (!Number.isFinite(total)) return { lines: 0, remainder }
  const lines = Math.trunc(total) || 0
  return { lines, remainder: total - lines }
}

export const MAX_REPORTS_PER_FRAME = 32

export interface ScrollPolicyDeps {
  term: Terminal
  sendInput: (data: string, isBinary?: boolean) => void
  getPref: () => TerminalScrollingPref
  requestFrame?: (cb: () => void) => number
  cancelFrame?: (id: number) => void
}

interface ScrollRun {
  count: number
  event: XtermMouseEvent
  target: 'mouse' | 'alt-cursor'
}

/** Precise TUI wheel quantities, using xterm's own restrictions and encoders. */
export class TerminalScrollPolicy {
  private remainder = 0
  private queue: ScrollRun[] = []
  private rafId: number | null = null
  private disposed = false
  private dispatching = false
  private nativeWheel = false
  private signature = ''
  private frameBudget = MAX_REPORTS_PER_FRAME
  private captured: { data: string; binary: boolean }[] = []
  private disposables: IDisposable[] = []
  private requestFrame: (cb: () => void) => number
  private cancelFrame: (id: number) => void

  constructor(private deps: ScrollPolicyDeps) {
    // WebKit requires Window as the receiver; storing the bare DOM method and
    // calling it on this policy throws "Illegal invocation" in a real WebView.
    this.requestFrame = deps.requestFrame ?? (cb => globalThis.requestAnimationFrame(cb))
    this.cancelFrame = deps.cancelFrame ?? (id => globalThis.cancelAnimationFrame(id))
    const retain = (d: IDisposable | undefined) => { if (d) this.disposables.push(d) }
    retain(deps.term.buffer.onBufferChange(() => this.clearQueue()))
    retain(xtermCore(deps.term)?.coreMouseService?.onProtocolChange(() => {
      if (this.signature && this.signature !== this.stateSignature()) this.clearQueue()
    }))
    retain(deps.term.onData(data => { if (this.dispatching) this.captured.push({ data, binary: false }) }))
    retain(deps.term.onBinary(data => { if (this.dispatching) this.captured.push({ data, binary: true }) }))
  }

  isDispatching(): boolean { return this.dispatching }
  isWheelInput(): boolean { return this.dispatching || this.nativeWheel }

  private native(): true {
    // xterm emits native wheel input synchronously after the custom hook.
    this.nativeWheel = true
    queueMicrotask(() => { this.nativeWheel = false })
    return true
  }

  private stateSignature(): string {
    const core = xtermCore(this.deps.term)
    return [this.deps.term.buffer.active.type, core?.coreMouseService?.activeProtocol,
      core?.coreMouseService?.activeEncoding, core?.coreService?.decPrivateModes?.applicationCursorKeys].join(':')
  }

  getScrollTarget(): 'viewport' | 'mouse' | 'alt-cursor' {
    const protocol = xtermCore(this.deps.term)?.coreMouseService?.activeProtocol
    if (protocol && protocol !== 'NONE') return 'mouse'
    return this.deps.term.buffer.active.type === 'alternate' ? 'alt-cursor' : 'viewport'
  }

  clearQueue(): void {
    this.queue = []
    this.remainder = 0
    this.signature = ''
    this.frameBudget = MAX_REPORTS_PER_FRAME
    if (this.rafId !== null) this.cancelFrame(this.rafId)
    this.rafId = null
  }

  handleWheel(event: WheelEventLike & { preventDefault?: () => void; defaultPrevented?: boolean }): boolean {
    if (this.disposed || event.defaultPrevented || !Number.isFinite(event.deltaY)) return true
    const pref = this.deps.getPref()
    if (pref.mode === 'compatibility' || event.shiftKey || event.ctrlKey || event.deltaY === 0 ||
      Math.abs(event.deltaX ?? 0) > Math.abs(event.deltaY)) return this.native()

    const target = this.getScrollTarget()
    if (target === 'viewport') return this.native()
    const term = this.deps.term
    const core = xtermCore(term)
    // X10 only supports presses. Let xterm reject wheel, as in native mode.
    if (target === 'mouse' && core.coreMouseService.activeProtocol === 'X10') return this.native()
    const signature = this.stateSignature()
    if (signature !== this.signature) { this.clearQueue(); this.signature = signature }
    const cellHeight = core._renderService?.dimensions.css.cell.height
    if (!cellHeight || !core._mouseService || !core.screenElement) return this.native()
    const coords = core._mouseService.getMouseReportCoords(event as unknown as MouseEvent, core.screenElement)
    if (!coords) return this.native()
    const result = normalizeWheelDelta(event, cellHeight, term.rows, pref.sensitivity, this.remainder, true, term.options.fastScrollSensitivity)
    this.remainder = result.remainder
    if (result.lines) {
      const mouse: XtermMouseEvent = { ...coords, button: 4, action: result.lines < 0 ? 0 : 1,
        ctrl: !!event.ctrlKey, alt: !!event.altKey, shift: !!event.shiftKey }
      // Run lengths bound work/allocation per event even for a large flick.
      this.queue.push({ count: Math.abs(result.lines), event: mouse, target })
      // Send a leading batch immediately; waiting for rAF before the PTY round
      // trip adds a whole frame of latency. Further input is coalesced at rAF.
      if (this.rafId === null) this.flushFrame()
      else this.scheduleFlush()
    }
    event.preventDefault?.()
    return false
  }

  private scheduleFlush(): void {
    if (this.rafId !== null) return
    this.rafId = this.requestFrame(() => {
      this.rafId = null
      this.frameBudget = MAX_REPORTS_PER_FRAME
      if (this.queue.length) this.flushFrame()
    })
  }

  flushFrame(): void {
    if (this.disposed || !this.queue.length) return
    if (this.deps.getPref().mode !== 'enhanced' || this.signature !== this.stateSignature()) {
      this.clearQueue()
      return
    }
    const core = xtermCore(this.deps.term)
    this.captured = []
    this.dispatching = true
    try {
      while (this.frameBudget > 0 && this.queue.length) {
        this.frameBudget--
        const run = this.queue[0]
        if (run.target === 'mouse') core.coreMouseService.triggerMouseEvent({ ...run.event })
        else {
          const prefix = core.coreService.decPrivateModes.applicationCursorKeys ? 'O' : '['
          core.coreService.triggerDataEvent(`\x1b${prefix}${run.event.action === 0 ? 'A' : 'B'}`, true)
        }
        if (--run.count === 0) this.queue.shift()
      }
    } finally { this.dispatching = false }
    // Preserve binary/text boundaries, and send only to the source PTY.
    let batch = ''
    let binary = this.captured[0]?.binary ?? false
    for (const part of this.captured) {
      if (part.binary !== binary) { this.deps.sendInput(batch, binary); batch = ''; binary = part.binary }
      batch += part.data
    }
    if (batch) this.deps.sendInput(batch, binary)
    this.captured = []
    this.scheduleFlush()
  }

  getPendingReportCount(): number { return this.queue.reduce((n, run) => n + run.count, 0) }

  dispose(): void {
    this.disposed = true
    this.clearQueue()
    for (const d of this.disposables) d.dispose()
    this.disposables = []
  }
}
