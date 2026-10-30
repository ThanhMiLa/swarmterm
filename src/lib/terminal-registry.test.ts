import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fit: vi.fn() }))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options = {}
    parser = { registerOscHandler: vi.fn() }
    loadAddon(addon: { activate?: (term: unknown) => void }): void { addon.activate?.(this) }
    open = vi.fn()
    dispose = vi.fn()
    onTitleChange = vi.fn()
    onData = vi.fn()
    registerLinkProvider = vi.fn()
    attachCustomKeyEventHandler = vi.fn()
  }
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    term!: { cols: number }
    activate(term: { cols: number }): void { this.term = term }
    fit(): void {
      mocks.fit()
      // A changing grid makes every fit observable at the IPC boundary too.
      this.term.cols += 1
    }
  }
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss = vi.fn() } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }))
vi.mock('@/tauri/terminal', () => ({
  createTerminal: vi.fn().mockResolvedValue({ ok: true }),
  killTerminal: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  writeTerminal: vi.fn().mockResolvedValue(undefined)
}))

import { resizeTerminal } from '@/tauri/terminal'
import {
  attachTerminal,
  beginLayoutTransition,
  detachTerminal,
  disposeOrphanTerminals,
  disposeTerminal,
  endLayoutTransition,
  refitAttachedTerminals
} from './terminal-registry'

const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0
let observers: { callback: () => void; disconnect: ReturnType<typeof vi.fn> }[]

function frame(): void {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach((fn) => fn(0))
}

function attach(id = 'one'): void {
  attachTerminal(id, { appendChild: vi.fn() } as unknown as HTMLElement, {})
}

beforeEach(() => {
  vi.useFakeTimers()
  frames.clear()
  observers = []
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    frames.set(++nextFrame, fn)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    createElement: () => ({
      style: {}, clientWidth: 800, clientHeight: 600,
      addEventListener: vi.fn(), remove: vi.fn()
    })
  })
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn()
    observe = vi.fn()
    constructor(callback: () => void) { observers.push({ callback, disconnect: this.disconnect }) }
  })
  attach()
  vi.clearAllMocks()
})

afterEach(() => {
  disposeOrphanTerminals(new Set())
  endLayoutTransition()
  frame()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('terminal layout refits', () => {
  it('coalesces a ResizeObserver burst to one fit and IPC per frame', () => {
    for (let i = 0; i < 30; i++) observers[0].callback()
    expect(mocks.fit).not.toHaveBeenCalled()
    frame()
    expect(mocks.fit).toHaveBeenCalledTimes(1)
    expect(resizeTerminal).toHaveBeenCalledTimes(1)
    observers[0].callback()
    frame()
    expect(mocks.fit).toHaveBeenCalledTimes(2)
  })

  it('performs zero intermediate fits/IPC and one final fit per attached terminal', () => {
    attach('two')
    vi.clearAllMocks()
    // Even an already queued observer frame must be cancelled on begin.
    observers.forEach((ro) => ro.callback())
    beginLayoutTransition()
    for (let i = 0; i < 25; i++) {
      observers.forEach((ro) => ro.callback())
      refitAttachedTerminals() // focus/visibility changes must respect the lock too
      vi.advanceTimersByTime(8)
      frame()
    }
    expect(mocks.fit).not.toHaveBeenCalled()
    expect(resizeTerminal).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20)
    // Observer delivery at the final size must share the global refit.
    observers.forEach((ro) => ro.callback())
    expect(mocks.fit).not.toHaveBeenCalled()
    frame()
    expect(mocks.fit).toHaveBeenCalledTimes(2)
    expect(resizeTerminal).toHaveBeenCalledTimes(2)
    endLayoutTransition() // late transitionend must not fit again after timeout
    vi.advanceTimersByTime(220)
    frame()
    expect(mocks.fit).toHaveBeenCalledTimes(2)
  })

  it('ends early via transitionend without another refit from the timeout', () => {
    beginLayoutTransition()
    vi.advanceTimersByTime(200)
    endLayoutTransition()
    endLayoutTransition()
    observers[0].callback()
    frame()
    expect(mocks.fit).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(220)
    frame()
    expect(mocks.fit).toHaveBeenCalledTimes(1)
  })

  it('resets the deadline and cancels a pending final refit on a new transition', () => {
    beginLayoutTransition()
    vi.advanceTimersByTime(200)
    beginLayoutTransition()
    vi.advanceTimersByTime(219)
    frame()
    expect(mocks.fit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    beginLayoutTransition()
    frame()
    expect(mocks.fit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(220)
    frame()
    expect(mocks.fit).toHaveBeenCalledTimes(1)
  })

  it('keeps refits locked when another sidebar finishes before the latest transition', () => {
    const left = beginLayoutTransition()
    vi.advanceTimersByTime(100)
    const right = beginLayoutTransition()
    vi.advanceTimersByTime(100)
    endLayoutTransition(left)
    observers[0].callback()
    frame()
    expect(mocks.fit).not.toHaveBeenCalled()
    expect(resizeTerminal).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    endLayoutTransition(right)
    frame()
    expect(mocks.fit).toHaveBeenCalledTimes(1)
  })

  it.each(['detach', 'dispose'] as const)('cancels pending observer refits on %s', (action) => {
    observers[0].callback()
    if (action === 'detach') detachTerminal('one')
    else disposeTerminal('one')
    frame()
    expect(mocks.fit).not.toHaveBeenCalled()
    expect(resizeTerminal).not.toHaveBeenCalled()
    expect(observers[0].disconnect).toHaveBeenCalledOnce()
  })

  it('does not fit a terminal detached during a layout transition', () => {
    beginLayoutTransition()
    detachTerminal('one')
    vi.advanceTimersByTime(220)
    frame()
    expect(mocks.fit).not.toHaveBeenCalled()
    expect(resizeTerminal).not.toHaveBeenCalled()
  })
})
