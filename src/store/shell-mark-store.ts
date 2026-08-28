import { create } from 'zustand'
import { applyShellMark, type CommandState, type ShellMark } from '@/lib/shell-marks'

/**
 * Per-terminal OSC 133 command state, keyed by terminalId. Runtime state that
 * lives OUTSIDE the layout tree — like terminal-title-store and the registry's
 * xterm instances — so a pane re-parenting (split collapse) keeps its phase,
 * and a respawn / kill clears it so a stale "running" never lingers.
 *
 * `applyMark` feeds `applyShellMark`, which returns `undefined` for every
 * non-transition (first-prompt `D;0`, an empty Enter redrawing the prompt, a
 * stray C). We then return the SAME state object to `set`, which zustand
 * treats as "nothing changed" and skips every listener — that is the whole
 * point of the machine returning undefined: subscribers (git-refresh, later
 * notifications) only ever wake for real transitions, and a consumer that
 * compares `byId[id].last` by identity gets a clean one-shot "finished" edge.
 */
export interface ShellMarkStore {
  byId: Record<string, CommandState>
  applyMark: (terminalId: string, mark: ShellMark, nowMs: number) => void
  clear: (terminalId: string) => void
}

export const useShellMarkStore = create<ShellMarkStore>((set) => ({
  byId: {},

  applyMark: (terminalId, mark, nowMs) =>
    set((s) => {
      const next = applyShellMark(s.byId[terminalId], mark, nowMs)
      return next === undefined ? s : { byId: { ...s.byId, [terminalId]: next } }
    }),

  clear: (terminalId) =>
    set((s) => {
      if (!(terminalId in s.byId)) return s
      const byId = { ...s.byId }
      delete byId[terminalId]
      return { byId }
    }),
}))
