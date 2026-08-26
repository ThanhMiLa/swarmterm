import { invoke } from '@tauri-apps/api/core'
import type { DisplayState } from '@/lib/agent-state/types'

/**
 * Push one pane's agent display state down to Rust (`commands::report_agent_state`),
 * where the MCP War Room peer verbs read it. Rust drops reports for ids that are
 * not live terminals, so a report racing a kill is harmless.
 */
export const reportAgentState = (id: string, display: DisplayState): Promise<void> =>
  invoke('report_agent_state', { id, display })
