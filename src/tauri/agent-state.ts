import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { DisplayState } from '@/lib/agent-state/types'

/**
 * Push one pane's agent display state down to Rust (`commands::report_agent_state`),
 * where the MCP War Room peer verbs read it. Rust drops reports for ids that are
 * not live terminals, so a report racing a kill is harmless.
 */
export const reportAgentState = (id: string, display: DisplayState): Promise<void> =>
  invoke('report_agent_state', { id, display })

/**
 * One Claude Code hook event, relayed by Rust's `POST /hook` route. Mirrors
 * `src-tauri/src/hook/mod.rs::AgentHookEvent` (serde camelCase / snake_case
 * signal) — keep the two in lockstep. `forget` means the pane's session
 * started or ended: drop hook authority and let screen-scrape resume alone.
 * Consumed by S5.3's detector routing.
 */
export type AgentHookSignal = 'working' | 'blocked' | 'idle' | 'forget'

export interface AgentHookEvent {
  terminalId: string
  signal: AgentHookSignal
  atMs: number
}

export const onAgentHook = (handler: (e: AgentHookEvent) => void): Promise<UnlistenFn> =>
  listen<AgentHookEvent>('agent:hook', (event) => handler(event.payload))
