import { ampManifest } from '@/lib/agent-state/manifests/amp'
import { claudeCodeManifest } from '@/lib/agent-state/manifests/claude-code'
import { codexManifest } from '@/lib/agent-state/manifests/codex'
import { copilotManifest } from '@/lib/agent-state/manifests/copilot'
import { opencodeManifest } from '@/lib/agent-state/manifests/opencode'
import { qwenManifest } from '@/lib/agent-state/manifests/qwen'
import type { Manifest } from '@/lib/agent-state/types'

/** Keyed by workspace template id (src/lib/templates.ts), NOT herdr agent id. */
const MANIFESTS: Record<string, Manifest> = {
  'claude-code': claudeCodeManifest,
  codex: codexManifest,
  opencode: opencodeManifest,
  copilot: copilotManifest,
  qwen: qwenManifest,
  amp: ampManifest
}

/** undefined for plain 'terminal' panes and unknown ids — no detection. */
export function manifestForAgent(agentId: string | undefined): Manifest | undefined {
  return agentId === undefined ? undefined : MANIFESTS[agentId]
}
