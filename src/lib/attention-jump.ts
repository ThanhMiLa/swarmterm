import { collectAttentionPanes, nextAttentionPane } from '@/lib/attention'
import { focusTerminal } from '@/lib/terminal-registry'
import { useAgentStateStore } from '@/store/agent-state-store'
import { selectFocusedTerminalId, useAppStore } from '@/store/app-store'

/**
 * Reveal + focus the next pane needing attention. Shared by the Mod+Shift+J
 * branch in App.tsx and the navbar badge so the ring is computed in one place
 * (same store/registry glue precedent as `war-room-delivery.ts`; the tested
 * logic lives in `attention.ts`).
 * `revealTerminal` switches workspace when needed (App.tsx's activeWorkspaceId
 * effect then focuses the pane once it mounts); the explicit `focusTerminal`
 * covers the same-workspace case where no mount happens.
 */
export function jumpToAttention(): boolean {
  const app = useAppStore.getState()
  const panes = collectAttentionPanes(app.workspaces, useAgentStateStore.getState().byId)
  const next = nextAttentionPane(panes, selectFocusedTerminalId(app))
  if (next === undefined) return false
  app.revealTerminal(next)
  focusTerminal(next)
  return true
}
