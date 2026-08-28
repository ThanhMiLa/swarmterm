import { create } from 'zustand'
import { NO_CHANGE, applyContextSample } from '@/lib/context-usage'

/**
 * Per-terminal context-window usage (rounded %), keyed by terminalId, fed by
 * the `agent:context` event that the `/status` probe of `swarmterm --statusline`
 * produces. Runtime state that lives OUTSIDE the layout tree — like
 * shell-mark-store and the registry's xterm instances — so a pane re-parenting
 * (split collapse) keeps its chip, and the registry clears it on kill/respawn
 * so a relaunched `claude` never inherits its predecessor's percentage for the
 * window between Exit and its own first reply.
 *
 * `apply` feeds `applyContextSample`, which answers `NO_CHANGE` for every
 * sample that would not move the shown integer — including the `null` Rust
 * publishes on EVERY Forget, even for panes that never showed anything. We
 * then return the SAME state object to `set`, which zustand treats as "nothing
 * changed" and skips every listener; that is what lets `TerminalPane`'s
 * per-terminal selector stay quiet while Claude re-runs the status line many
 * times a second during streaming. A cleared value deletes the key rather than
 * storing `undefined`, so `terminalId in byId` stays a truthful "is a chip
 * shown" test.
 */
export interface ContextUsageStore {
  byId: Record<string, number>
  apply: (terminalId: string, pct: number | null) => void
  clear: (terminalId: string) => void
}

export const useContextUsageStore = create<ContextUsageStore>((set) => ({
  byId: {},

  apply: (terminalId, pct) =>
    set((s) => {
      const next = applyContextSample(s.byId[terminalId], pct)
      if (next === NO_CHANGE) return s
      if (next === undefined) {
        const byId = { ...s.byId }
        delete byId[terminalId]
        return { byId }
      }
      return { byId: { ...s.byId, [terminalId]: next } }
    }),

  clear: (terminalId) =>
    set((s) => {
      if (!(terminalId in s.byId)) return s
      const byId = { ...s.byId }
      delete byId[terminalId]
      return { byId }
    }),
}))
