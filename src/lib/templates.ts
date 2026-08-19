/**
 * Workspace templates offered by the setup wizard. A template decides the
 * command each terminal runs once on first spawn (`null` means a plain shell).
 */

import claudeIcon from '@/assets/agents/claude-code.svg'
import codexIcon from '@/assets/agents/codex.svg'
import opencodeIcon from '@/assets/agents/opencode.svg'

/** Session ids come from on-disk stores owned by other programs and end up
 *  typed into a live shell line — each pattern is an allow-list of the exact
 *  shape that CLI emits, not a sanity check. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// OpenCode: "ses_" + 12 hex + 14 base62 today; ranged so a minor format bump
// doesn't silently kill the feature, while still shell-safe ([A-Za-z0-9] only).
const OPENCODE_RE = /^ses_[A-Za-z0-9]{10,40}$/

/** Which backend store scanner (src-tauri/src/sessions/) feeds the composer's
 *  "Resume sessions" list for this agent. The Rust side mirrors these tags. */
export type SessionScannerKind = 'claude-jsonl' | 'codex-rollout' | 'opencode-cli' | 'qwen-chats'

export interface TemplateResume {
  /** Exact session-id shape this CLI emits. */
  idPattern: RegExp
  /** One-line resume command, built on the template's base command so flag
   *  changes (e.g. the claude permissions flag) carry over automatically. */
  buildCommand: (base: string, sessionId: string) => string
}

export interface WorkspaceTemplate {
  id: string
  name: string
  description: string
  /** Command run when each terminal first spawns, or `null` for a plain shell. */
  command: string | null
  /** Executable probed by the backend to decide availability; `undefined` ⇒ always available. */
  executable?: string
  /** Brand logo URL for the agent, or `undefined` for the plain terminal. */
  icon?: string
  /** Resume support (L2): absent ⇒ the CLI cannot resume a session by id. */
  resume?: TemplateResume
  /** Store scanner feeding "Resume sessions"; absent ⇒ the agent has no
   *  scanner yet and never appears in that list (fail-open by construction). */
  sessionScanner?: SessionScannerKind
}

export const TEMPLATES: WorkspaceTemplate[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: "Anthropic's coding agent.",
    command: 'claude --dangerously-skip-permissions',
    executable: 'claude',
    icon: claudeIcon,
    // Permission mode is never restored on resume — the flag must ride again,
    // which building on `base` guarantees.
    resume: { idPattern: UUID_RE, buildCommand: (base, id) => `${base} --resume ${id}` },
    sessionScanner: 'claude-jsonl'
  },
  {
    id: 'codex',
    name: 'Codex',
    description: "OpenAI's Codex CLI.",
    command: 'codex',
    executable: 'codex',
    icon: codexIcon,
    // `codex resume <id>` is a subcommand, not a flag.
    resume: { idPattern: UUID_RE, buildCommand: (base, id) => `${base} resume ${id}` },
    sessionScanner: 'codex-rollout'
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'Open-source terminal coding agent.',
    command: 'opencode',
    executable: 'opencode',
    icon: opencodeIcon,
    resume: { idPattern: OPENCODE_RE, buildCommand: (base, id) => `${base} --session ${id}` },
    sessionScanner: 'opencode-cli'
  },
  {
    id: 'terminal',
    name: 'Terminal',
    description: 'A plain shell — runs no command.',
    command: null
  }
]

export const DEFAULT_TEMPLATE_ID = 'terminal'

/** The template with `id`, or the default template when `id` is unknown. */
export function templateById(id: string): WorkspaceTemplate {
  return (
    TEMPLATES.find((t) => t.id === id) ??
    TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE_ID) ??
    TEMPLATES[0]
  )
}

/** The startup command for an agent id, or `undefined` for a plain shell. */
export function agentCommand(agentId: string | undefined): string | undefined {
  return templateById(agentId ?? DEFAULT_TEMPLATE_ID).command ?? undefined
}

/**
 * Template id → installed?, from the backend probe (`list_available_agents`).
 * A missing id reads as installed — optimistic, so a pending or failed probe
 * never locks out a working CLI.
 */
export type AgentAvailabilityMap = Record<string, boolean>

/** Whether a template's CLI is installed. Templates with no executable (plain
 *  Terminal) are always available. */
export function isTemplateAvailable(
  template: WorkspaceTemplate,
  availability: AgentAvailabilityMap
): boolean {
  if (!template.executable) return true
  return availability[template.id] !== false
}
