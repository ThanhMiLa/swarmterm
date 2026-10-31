/**
 * Robust WebGL renderer lifecycle manager for xterm.js.
 *
 * States:
 * - uninitialized: addon has not been created yet
 * - initializing: addon is being instantiated and loaded
 * - active: WebGL rendering is running successfully on GPU
 * - fallback: WebGL context lost or unavailable; fallen back to DOM renderer
 * - recovering: attempting recovery back to WebGL
 * - disposed: terminal permanently torn down
 *
 * Retries:
 * - Maximum two retries (1s, then 3s) only while pane is visible.
 * - Stops after two retries to avoid continuous retry loops.
 * - Re-arms when pane is re-attached or tab regains visibility.
 */

import { WebglAddon } from '@xterm/addon-webgl'
import type { IDisposable, Terminal } from '@xterm/xterm'

const STABLE_CONTEXT_MS = 10_000

export type WebglStatus =
  | 'uninitialized'
  | 'initializing'
  | 'active'
  | 'fallback'
  | 'recovering'
  | 'disposed'

export interface WebglManagerOptions {
  id: string
  term: Terminal
  host: HTMLElement
  onRefitNeeded?: () => void
  isPaneVisible?: () => boolean
  createAddon?: () => WebglAddon
}

export class TerminalWebglManager {
  private status: WebglStatus = 'uninitialized'
  private addon: WebglAddon | null = null
  private retryCount = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private lastError: string | null = null
  private contexts: WebGL2RenderingContext[] = []
  private contextLossListener: IDisposable | null = null
  private activeSince: number | null = null

  constructor(private readonly opts: WebglManagerOptions) {}

  getStatus(): WebglStatus {
    return this.status
  }

  getLastError(): string | null {
    return this.lastError
  }

  getRetryCount(): number {
    return this.retryCount
  }

  /**
   * Check if the terminal pane is currently visible and laid out in DOM.
   */
  private isVisible(): boolean {
    if (this.opts.isPaneVisible) return this.opts.isPaneVisible()
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false
    const host = this.opts.host
    if (!host.isConnected) return false
    return host.clientWidth > 0 && host.clientHeight > 0
  }

  /**
   * Attempt to load and activate the WebGL addon.
   */
  load(): void {
    if (this.status === 'active' || this.status === 'disposed') return

    this.clearRetryTimer()
    this.status = this.status === 'fallback' ? 'recovering' : 'initializing'

    try {
      const addon = this.opts.createAddon ? this.opts.createAddon() : new WebglAddon()
      this.addon = addon
      this.contextLossListener = addon.onContextLoss(() => {
        // A late event from a disposed addon must not tear down its replacement.
        if (this.addon === addon) this.handleContextLoss('WebGL context lost')
      })

      this.opts.term.loadAddon(addon)
      if (this.addon !== addon) return // context loss during activation already fell back
      this.contexts = Array.from(this.opts.host.querySelectorAll?.('.xterm-screen > canvas') ?? [])
        .map(canvas => (canvas as HTMLCanvasElement).getContext('webgl2'))
        .filter((context): context is WebGL2RenderingContext => context !== null)
      this.status = 'active'
      this.activeSince = performance.now()
      this.lastError = null
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.handleContextLoss(this.lastError)
    }
  }

  /**
   * Handle WebGL context loss or init failure by disposing addon,
   * switching to DOM fallback, and scheduling bounded recovery.
   */
  private handleContextLoss(reason: string): void {
    if (this.status === 'disposed') return

    // Some GPUs repeatedly activate successfully, then immediately lose their
    // context. Only a stable active period earns a fresh retry budget.
    if (this.activeSince !== null && performance.now() - this.activeSince >= STABLE_CONTEXT_MS) {
      this.retryCount = 0
    }
    this.activeSince = null
    this.lastError = reason
    this.status = 'fallback'
    this.disposeAddon()

    // Notify caller that DOM renderer took over and might need cell remeasurement
    if (this.opts.onRefitNeeded) {
      setTimeout(() => {
        if (this.status !== 'disposed') this.opts.onRefitNeeded?.()
      }, 0)
    }

    this.scheduleRetry()
  }

  /**
   * Schedule retry up to 2 times (at 1s and 3s) only if pane is visible.
   */
  private scheduleRetry(): void {
    if (this.status === 'disposed' || this.status === 'active') return
    if (this.retryCount >= 2) return // Stop retrying after 2 attempts

    if (!this.isVisible()) {
      // Defer retry until pane is re-attached or visible
      return
    }

    this.retryCount++
    const delay = this.retryCount === 1 ? 1000 : 3000

    this.clearRetryTimer()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.status === 'fallback' && this.isVisible()) {
        this.load()
      }
    }, delay)
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private releaseContexts(): void {
    // Disposing the addon frees buffers but WebKit can retain the GPU context
    // until GC. Explicit release avoids exhausting contexts as panes are closed.
    for (const context of this.contexts) {
      try { context.getExtension('WEBGL_lose_context')?.loseContext() } catch { /* already lost */ }
    }
    this.contexts = []
  }

  private disposeAddon(): void {
    const addon = this.addon
    this.addon = null
    this.contextLossListener?.dispose()
    this.contextLossListener = null
    try { addon?.dispose() } catch { /* preserve DOM fallback even if cleanup fails */ }
    this.releaseContexts()
  }

  /**
   * Notify that the pane has been re-attached or became visible.
   * Resets retry quota and attempts recovery if currently on fallback.
   */
  onVisibleOrAttached(): void {
    if (this.status === 'disposed' || this.status === 'active') return

    if (this.status === 'fallback') {
      this.clearRetryTimer()
      this.retryCount = 0
      if (this.isVisible()) {
        this.load()
      }
    }
  }

  /**
   * Permanently dispose the WebGL manager.
   */
  dispose(): void {
    this.clearRetryTimer()
    this.status = 'disposed'
    this.activeSince = null
    this.disposeAddon()
  }
}
