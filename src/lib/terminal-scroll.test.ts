import { describe, it, expect, vi, afterEach } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { xtermCore } from './terminal-xterm'
import {
  normalizeWheelDelta,
  TerminalScrollPolicy,
  MAX_REPORTS_PER_FRAME
} from './terminal-scroll'
import type { TerminalScrollingPref } from './terminal-scrolling'

describe('terminal-scroll delta normalization', () => {
  it('normalizes DOM_DELTA_PIXEL using cell height', () => {
    // 36 pixels with cell height 18 = 2.0 lines
    const res = normalizeWheelDelta({ deltaY: 36, deltaMode: 0 }, 18, 24, 1.0, 0, true)
    expect(res.lines).toBe(2)
    expect(res.remainder).toBe(0)
  })

  it('keeps fractional remainder in pixel mode', () => {
    // 27 pixels with cell height 18 = 1.5 lines
    const res1 = normalizeWheelDelta({ deltaY: 27, deltaMode: 0 }, 18, 24, 1.0, 0, true)
    expect(res1.lines).toBe(1)
    expect(res1.remainder).toBeCloseTo(0.5, 4)

    // Next event with 18 pixels (1.0 line) + 0.5 remainder = 1.5 lines -> 1 line + 0.5
    const res2 = normalizeWheelDelta({ deltaY: 18, deltaMode: 0 }, 18, 24, 1.0, res1.remainder, true)
    expect(res2.lines).toBe(1)
    expect(res2.remainder).toBeCloseTo(0.5, 4)

    // Next event with 9 pixels (0.5 line) + 0.5 remainder = 1.0 line -> 1 line + 0 remainder
    const res3 = normalizeWheelDelta({ deltaY: 9, deltaMode: 0 }, 18, 24, 1.0, res2.remainder, true)
    expect(res3.lines).toBe(1)
    expect(res3.remainder).toBeCloseTo(0, 4)
  })

  it('preserves fractional remainder when direction reverses', () => {
    // Scroll down 27 px (1.5 lines) -> lines = 1, remainder = +0.5
    const res1 = normalizeWheelDelta({ deltaY: 27, deltaMode: 0 }, 18, 24, 1.0, 0, true)
    expect(res1.lines).toBe(1)
    expect(res1.remainder).toBeCloseTo(0.5, 4)

    // Then user immediately scrolls up -18 px (-1.0 line) + 0.5 = -0.5 line -> lines = 0, remainder = -0.5
    const res2 = normalizeWheelDelta({ deltaY: -18, deltaMode: 0 }, 18, 24, 1.0, res1.remainder, true)
    expect(res2.lines).toBe(0)
    expect(res2.remainder).toBeCloseTo(-0.5, 4)

    // Another up scroll of -18 px (-1.0 line) + (-0.5) = -1.5 lines -> lines = -1, remainder = -0.5
    const res3 = normalizeWheelDelta({ deltaY: -18, deltaMode: 0 }, 18, 24, 1.0, res2.remainder, true)
    expect(res3.lines).toBe(-1)
    expect(res3.remainder).toBeCloseTo(-0.5, 4)
  })

  it('does NOT damp small pixel deltas < 50 by 0.3 in enhanced mode', () => {
    // 36 pixels (< 50) with cell height 18
    const enhanced = normalizeWheelDelta({ deltaY: 36, deltaMode: 0 }, 18, 24, 1.0, 0, true)
    expect(enhanced.lines).toBe(2)

    // In compatibility mode, 36 * 0.3 = 10.8 px / 18 = 0.6 lines -> lines = 0, remainder = 0.6
    const compat = normalizeWheelDelta({ deltaY: 36, deltaMode: 0 }, 18, 24, 1.0, 0, false)
    expect(compat.lines).toBe(0)
    expect(compat.remainder).toBeCloseTo(0.6, 4)
  })

  it('normalizes DOM_DELTA_LINE directly', () => {
    const res = normalizeWheelDelta({ deltaY: 3, deltaMode: 1 }, 18, 24, 1.0, 0, true)
    expect(res.lines).toBe(3)
    expect(res.remainder).toBe(0)
  })

  it('normalizes DOM_DELTA_PAGE by viewport row count', () => {
    const res = normalizeWheelDelta({ deltaY: 2, deltaMode: 2 }, 18, 30, 1.0, 0, true)
    expect(res.lines).toBe(60) // 2 * 30
    expect(res.remainder).toBe(0)
  })

  it('applies sensitivity multiplier correctly', () => {
    // 36 px / 18 = 2.0 lines * 1.5 sensitivity = 3.0 lines
    const res = normalizeWheelDelta({ deltaY: 36, deltaMode: 0 }, 18, 24, 1.5, 0, true)
    expect(res.lines).toBe(3)
    expect(res.remainder).toBe(0)
  })
})

describe('TerminalScrollPolicy with the installed xterm package', () => {
  const disposables: (() => void)[] = []
  afterEach(() => { for (const dispose of disposables.splice(0)) dispose() })

  function fixture(protocol = 'VT200', encoding = 'SGR') {
    const term = new Terminal({ allowProposedApi: true, cols: 240, rows: 24 })
    const core = xtermCore(term)
    core.coreMouseService.activeProtocol = protocol
    core.coreMouseService.activeEncoding = encoding
    core.screenElement = {} as HTMLElement
    core._renderService = Object.assign({ dimensions: { css: { cell: { width: 9, height: 18 } } }, onRender: () => ({ dispose() {} }) }, { refreshRows: vi.fn() })
    core._mouseService = { getMouseReportCoords: () => ({ col: 9, row: 4, x: 80, y: 72 }) }
    let pref: TerminalScrollingPref = { mode: 'enhanced', sensitivity: 1.5, smoothMouseWheel: true }
    const frames = new Map<number, () => void>()
    let next = 0
    const sent: { data: string; binary?: boolean }[] = []
    const policy = new TerminalScrollPolicy({ term, getPref: () => pref,
      sendInput: (data, binary) => sent.push({ data, binary }),
      requestFrame: cb => { frames.set(++next, cb); return next },
      cancelFrame: id => { frames.delete(id) } })
    const wheel = (overrides = {}) => ({ deltaY: 36, deltaX: 0, deltaMode: 0, clientX: 85, clientY: 75, preventDefault: vi.fn(), ...overrides })
    const frame = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(cb => cb()) }
    disposables.push(() => { policy.dispose(); term.dispose() })
    return { term, core, policy, sent, wheel, frame, setPref: (value: TerminalScrollingPref) => { pref = value } }
  }

  it('uses real xterm encoding and sends exactly one batch of three reports', () => {
    const f = fixture()
    expect(f.policy.handleWheel(f.wheel())).toBe(false)
    expect(f.policy.getPendingReportCount()).toBe(0)
    f.frame()
    expect(f.sent).toEqual([{ data: '\x1b[<65;10;5M'.repeat(3), binary: false }])
  })

  it('caps reports per frame without dropping a large flick', () => {
    const f = fixture()
    f.policy.handleWheel(f.wheel({ deltaY: 600 }))
    expect(f.policy.getPendingReportCount()).toBe(18)
    expect(f.sent[0].data.match(/M/g)?.length).toBe(MAX_REPORTS_PER_FRAME)
    f.frame()
    expect(f.policy.getPendingReportCount()).toBe(0)
    expect(f.sent.map(x => x.data).join('').match(/M/g)?.length).toBe(50)
  })

  it('rejects wheel in X10 just like native xterm', () => {
    const f = fixture('X10')
    expect(f.policy.handleWheel(f.wheel())).toBe(true)
    f.frame()
    expect(f.sent).toEqual([])
  })

  it('preserves legacy bytes and suppresses out-of-range legacy positions', () => {
    const f = fixture('VT200', 'DEFAULT')
    f.core._mouseService!.getMouseReportCoords = () => ({ col: 150, row: 4, x: 1350, y: 72 })
    f.policy.handleWheel(f.wheel())
    f.frame()
    expect(f.sent[0].binary).toBe(true)
    expect(f.sent[0].data.charCodeAt(4)).toBe(183)
    f.core._mouseService!.getMouseReportCoords = () => ({ col: 230, row: 4, x: 2070, y: 72 })
    f.policy.handleWheel(f.wheel())
    f.frame()
    expect(f.sent.length).toBe(1)
  })

  it('uses measured integer pixel coordinates, rather than the outer host rectangle', () => {
    const f = fixture('VT200', 'SGR_PIXELS')
    f.policy.handleWheel(f.wheel({ clientX: 90.25, clientY: 90.5 }))
    f.frame()
    expect(f.sent[0].data).toBe('\x1b[<65;80;72M'.repeat(3))
  })

  it('cancels queued input immediately when mouse tracking is disabled', () => {
    const f = fixture()
    f.policy.handleWheel(f.wheel({ deltaY: 600 }))
    f.sent.length = 0
    f.core.coreMouseService.activeProtocol = 'NONE'
    f.frame()
    expect(f.sent).toEqual([])
    expect(f.policy.getPendingReportCount()).toBe(0)
  })

  it('cancels queued input when encoding changes before flush', () => {
    const f = fixture()
    f.policy.handleWheel(f.wheel({ deltaY: 600 }))
    f.sent.length = 0
    f.core.coreMouseService.activeEncoding = 'DEFAULT'
    f.frame()
    expect(f.sent).toEqual([])
  })

  it('cancels queued input on buffer switch, terminal reset, preference rollback and disposal', async () => {
    const f = fixture()
    for (const sequence of ['\x1b[?1049h', '\x1bc']) {
      f.core.coreMouseService.activeProtocol = 'VT200'
      f.policy.handleWheel(f.wheel({ deltaY: 600 }))
      f.sent.length = 0
      await new Promise<void>(resolve => f.term.write(sequence, resolve))
      f.frame()
      expect(f.sent).toEqual([])
    }
    f.core.coreMouseService.activeProtocol = 'VT200'
    f.policy.handleWheel(f.wheel({ deltaY: 600 }))
    f.sent.length = 0
    f.setPref({ mode: 'compatibility', sensitivity: 1.5, smoothMouseWheel: true })
    f.frame()
    expect(f.sent).toEqual([])
    f.policy.dispose()
    expect(f.policy.getPendingReportCount()).toBe(0)
  })

  it('leaves native wheel, shift-selection, pinch and horizontal gestures untouched', async () => {
    const f = fixture()
    for (const overrides of [{ shiftKey: true }, { ctrlKey: true }, { deltaY: 0, deltaX: 20 }, { deltaY: 10, deltaX: 40 }]) {
      const event = f.wheel(overrides)
      expect(f.policy.handleWheel(event)).toBe(true)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(f.policy.isWheelInput()).toBe(true)
      await Promise.resolve()
      expect(f.policy.isWheelInput()).toBe(false)
    }
  })

  it('generates native application-cursor fallback without marking binary input', async () => {
    const f = fixture('NONE')
    await new Promise<void>(resolve => f.term.write('\x1b[?1049h\x1b[?1h', resolve))
    f.policy.handleWheel(f.wheel())
    f.frame()
    expect(f.sent).toEqual([{ data: '\x1bOB'.repeat(3), binary: false }])
  })
  it('calls browser frame APIs with their global receiver', () => {
    const f = fixture()
    const request = vi.fn(function(this: unknown, _callback: () => void) {
      expect(this).toBe(globalThis)
      return 123
    })
    const cancel = vi.fn(function(this: unknown, _id: number) { expect(this).toBe(globalThis) })
    vi.stubGlobal('requestAnimationFrame', request)
    vi.stubGlobal('cancelAnimationFrame', cancel)
    try {
      const policy = new TerminalScrollPolicy({ term: f.term, getPref: () => ({ mode: 'enhanced', sensitivity: 1.5, smoothMouseWheel: true }), sendInput: vi.fn() })
      policy.handleWheel(f.wheel())
      expect(request).toHaveBeenCalledOnce()
      policy.dispose()
      expect(cancel).toHaveBeenCalledWith(123)
    } finally { vi.unstubAllGlobals() }
  })

  it('keeps pending quantities when an application repeats the same mouse mode', () => {
    const f = fixture()
    f.policy.handleWheel(f.wheel({ deltaY: 600 }))
    expect(f.policy.getPendingReportCount()).toBe(18)
    f.core.coreMouseService.activeProtocol = 'VT200'
    expect(f.policy.getPendingReportCount()).toBe(18)
    f.frame()
    expect(f.sent.map(x => x.data).join('').match(/M/g)?.length).toBe(50)
  })

  it('never emits more than 32 reports in one frame even during a burst', () => {
    const f = fixture()
    for (let i = 0; i < 3; i++) f.policy.handleWheel(f.wheel({ deltaY: 600 }))
    expect(f.sent[0].data.match(/M/g)?.length).toBe(32)
    expect(f.sent.length).toBe(1)
    while (f.policy.getPendingReportCount()) f.frame()
    for (const write of f.sent) expect(write.data.match(/M/g)!.length).toBeLessThanOrEqual(32)
    expect(f.sent.map(x => x.data).join('').match(/M/g)?.length).toBe(150)
  })

})
