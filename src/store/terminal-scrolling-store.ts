import { create } from 'zustand'
import {
  DEFAULT_SCROLLING_PREF,
  readStoredScrollingPref,
  storeScrollingPref,
  normalizeSensitivity,
  type ScrollingMode,
  type TerminalScrollingPref
} from '@/lib/terminal-scrolling'

export interface TerminalScrollingStore {
  scrolling: TerminalScrollingPref
  setMode: (mode: ScrollingMode) => void
  setSensitivity: (sensitivity: number) => void
  setSmoothMouseWheel: (enabled: boolean) => void
  setScrollingPref: (pref: Partial<TerminalScrollingPref>) => void
}

/**
 * Zustand store for terminal scrolling preferences.
 * Persists to localStorage and notifies subscribers immediately.
 */
export const useTerminalScrollingStore = create<TerminalScrollingStore>((set, get) => {
  const initial =
    typeof window === 'undefined'
      ? DEFAULT_SCROLLING_PREF
      : readStoredScrollingPref(window.localStorage)

  const persist = (next: TerminalScrollingPref) => {
    if (typeof window !== 'undefined') {
      storeScrollingPref(window.localStorage, next)
    }
    set({ scrolling: next })
  }

  return {
    scrolling: initial,
    setMode: (mode) => persist({ ...get().scrolling, mode }),
    setSensitivity: (sensitivity) =>
      persist({ ...get().scrolling, sensitivity: normalizeSensitivity(sensitivity) }),
    setSmoothMouseWheel: (smoothMouseWheel) =>
      persist({ ...get().scrolling, smoothMouseWheel }),
    setScrollingPref: (patch) => {
      const current = get().scrolling
      const next: TerminalScrollingPref = {
        mode: patch.mode ?? current.mode,
        sensitivity:
          patch.sensitivity !== undefined
            ? normalizeSensitivity(patch.sensitivity)
            : current.sensitivity,
        smoothMouseWheel: patch.smoothMouseWheel ?? current.smoothMouseWheel
      }
      persist(next)
    }
  }
})
