import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TerminalWebglManager } from './terminal-webgl'

describe('TerminalWebglManager lifecycle and retry logic', () => {
  let mockTerm: any
  let mockHost: any
  let contextLossCb: (() => void) | null = null
  let loadAddonThrow = false

  const createMockAddon = () => {
    if (loadAddonThrow) {
      throw new Error('WebGL unavailable')
    }
    return {
      onContextLoss: (cb: () => void) => {
        contextLossCb = cb
        return { dispose: vi.fn() }
      },
      dispose: vi.fn()
    } as any
  }

  beforeEach(() => {
    vi.useFakeTimers()
    contextLossCb = null
    loadAddonThrow = false

    mockHost = {
      isConnected: true,
      clientWidth: 800,
      clientHeight: 600
    }

    mockTerm = {
      loadAddon: vi.fn()
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('initializes to uninitialized and transitions to active on load', () => {
    const mgr = new TerminalWebglManager({
      id: 'term-1',
      term: mockTerm,
      host: mockHost,
      createAddon: createMockAddon
    })
    expect(mgr.getStatus()).toBe('uninitialized')

    mgr.load()
    expect(mgr.getStatus()).toBe('active')
    expect(mgr.getLastError()).toBeNull()
    expect(mgr.getRetryCount()).toBe(0)
  })

  it('falls back on init error and schedules 2 bounded retries', () => {
    loadAddonThrow = true
    const mgr = new TerminalWebglManager({
      id: 'term-1',
      term: mockTerm,
      host: mockHost,
      createAddon: createMockAddon
    })

    mgr.load()
    expect(mgr.getStatus()).toBe('fallback')
    expect(mgr.getLastError()).toBe('WebGL unavailable')
    expect(mgr.getRetryCount()).toBe(1)

    // Advance 1s -> Retry 1 triggers
    vi.advanceTimersByTime(1000)
    expect(mgr.getStatus()).toBe('fallback')
    expect(mgr.getRetryCount()).toBe(2)

    // Advance 3s -> Retry 2 triggers
    vi.advanceTimersByTime(3000)
    expect(mgr.getStatus()).toBe('fallback')
    expect(mgr.getRetryCount()).toBe(2)

    // Subsequent time advances do NOT retry again (bounded at 2)
    vi.advanceTimersByTime(10000)
    expect(mgr.getRetryCount()).toBe(2)
  })

  it('handles context loss after active state and recovers when successful', () => {
    const onRefit = vi.fn()
    const mgr = new TerminalWebglManager({
      id: 'term-1',
      term: mockTerm,
      host: mockHost,
      onRefitNeeded: onRefit,
      createAddon: createMockAddon
    })

    mgr.load()
    expect(mgr.getStatus()).toBe('active')
    expect(contextLossCb).not.toBeNull()

    // Trigger context loss
    contextLossCb!()
    expect(mgr.getStatus()).toBe('fallback')
    expect(mgr.getLastError()).toBe('WebGL context lost')

    // Refit is scheduled
    vi.advanceTimersByTime(1)
    expect(onRefit).toHaveBeenCalled()

    // Retry 1 after 1000ms succeeds
    vi.advanceTimersByTime(1000)
    expect(mgr.getStatus()).toBe('active')
    expect(mgr.getRetryCount()).toBe(1) // activation alone does not refill the retry budget
  })

  it('does NOT schedule timers when pane is hidden/detached, but recovers on visible', () => {
    loadAddonThrow = true
    let isVisible = false
    const mgr = new TerminalWebglManager({
      id: 'term-1',
      term: mockTerm,
      host: mockHost,
      isPaneVisible: () => isVisible,
      createAddon: createMockAddon
    })

    mgr.load()
    expect(mgr.getStatus()).toBe('fallback')
    // Since pane is hidden, retryCount is 0 and no timer is set
    expect(mgr.getRetryCount()).toBe(0)
    vi.advanceTimersByTime(5000)

    // Pane becomes visible and WebGL now succeeds
    isVisible = true
    loadAddonThrow = false
    mgr.onVisibleOrAttached()
    expect(mgr.getStatus()).toBe('active')
    expect(mgr.getRetryCount()).toBe(0)
  })

  it('stops completely on dispose', () => {
    loadAddonThrow = true
    const mgr = new TerminalWebglManager({
      id: 'term-1',
      term: mockTerm,
      host: mockHost,
      createAddon: createMockAddon
    })
    mgr.load()
    expect(mgr.getStatus()).toBe('fallback')

    mgr.dispose()
    expect(mgr.getStatus()).toBe('disposed')
    vi.advanceTimersByTime(10000)
  })
  it('releases GPU contexts after disposing the addon rather than waiting for GC', () => {
    const order: string[] = []
    const loseContext = vi.fn(() => { order.push('context') })
    mockHost.querySelectorAll = () => [{ getContext: () => ({ getExtension: () => ({ loseContext }) }) }]
    const addon = { onContextLoss: vi.fn(), dispose: vi.fn(() => { order.push('addon') }) } as any
    const manager = new TerminalWebglManager({ id: 'gpu', term: mockTerm, host: mockHost, createAddon: () => addon })
    manager.load()
    manager.dispose()
    expect(order).toEqual(['addon', 'context'])
    manager.dispose()
    expect(loseContext).toHaveBeenCalledOnce()
  })

  it('disposes an addon whose activation fails', () => {
    const addon = createMockAddon()
    mockTerm.loadAddon.mockImplementation(() => { throw new Error('GPU activation failed') })
    const manager = new TerminalWebglManager({ id: 'gpu', term: mockTerm, host: mockHost, createAddon: () => addon })
    manager.load()
    expect(addon.dispose).toHaveBeenCalledOnce()
    expect(manager.getStatus()).toBe('fallback')
    manager.dispose()
  })

  it('stops after two retries when activation succeeds but contexts keep failing immediately', () => {
    const createAddon = vi.fn(createMockAddon)
    const manager = new TerminalWebglManager({ id: 'gpu', term: mockTerm, host: mockHost, createAddon })
    manager.load()
    contextLossCb!()
    vi.advanceTimersByTime(1000)
    expect(manager.getStatus()).toBe('active')
    contextLossCb!()
    vi.advanceTimersByTime(2999)
    expect(createAddon).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    expect(manager.getStatus()).toBe('active')
    contextLossCb!()
    vi.advanceTimersByTime(60_000)
    expect(createAddon).toHaveBeenCalledTimes(3)
    expect(manager.getStatus()).toBe('fallback')
    expect(manager.getRetryCount()).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
    manager.dispose()
  })

  it('earns a new retry budget after ten seconds of stable rendering', () => {
    const manager = new TerminalWebglManager({ id: 'gpu', term: mockTerm, host: mockHost, createAddon: createMockAddon })
    manager.load()
    contextLossCb!()
    vi.advanceTimersByTime(1000)
    expect(manager.getRetryCount()).toBe(1)
    vi.advanceTimersByTime(10_000)
    contextLossCb!()
    expect(manager.getRetryCount()).toBe(1) // first retry in a fresh failure episode
    vi.advanceTimersByTime(1000)
    expect(manager.getStatus()).toBe('active')
    manager.dispose()
  })

  it('ignores stale context-loss events after a replacement is active', () => {
    const addons: any[] = []
    const createAddon = () => { const addon = createMockAddon(); addons.push(addon); return addon }
    const manager = new TerminalWebglManager({ id: 'gpu', term: mockTerm, host: mockHost, createAddon })
    manager.load()
    const staleEvent = contextLossCb!
    staleEvent()
    vi.advanceTimersByTime(1000)
    staleEvent()
    expect(manager.getStatus()).toBe('active')
    expect(addons[1].dispose).not.toHaveBeenCalled()
    manager.dispose()
  })

  it('keeps fallback when activation itself signals context loss', () => {
    const addon = createMockAddon()
    mockTerm.loadAddon.mockImplementation(() => contextLossCb!())
    const manager = new TerminalWebglManager({ id: 'gpu', term: mockTerm, host: mockHost, createAddon: () => addon })
    manager.load()
    expect(manager.getStatus()).toBe('fallback')
    expect(addon.dispose).toHaveBeenCalledOnce()
    manager.dispose()
  })

})
