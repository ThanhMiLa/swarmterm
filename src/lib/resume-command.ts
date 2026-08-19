/**
 * Resume-command construction for agent panes. Session ids come from on-disk
 * stores owned by other programs — treat them as untrusted input. The id is
 * embedded in a line typed into a live shell, so instead of quoting we
 * allow-list the exact shapes each CLI emits and refuse everything else.
 * The shapes and command forms live in the template catalog (templates.ts);
 * this module only applies them.
 */
import { agentCommand, templateById } from '@/lib/templates'

export function isValidSessionId(agentId: string, sessionId: string): boolean {
  const t = templateById(agentId)
  // templateById falls back to the default template for unknown ids.
  if (t.id !== agentId || t.resume === undefined) return false
  return t.resume.idPattern.test(sessionId)
}

/**
 * The one-line command that respawns `sessionId` under `agentId`, or
 * `undefined` when the id fails validation or the agent cannot resume
 * (plain terminal, unknown template, no resume rule). Built on `agentCommand`
 * so template flag changes (e.g. the claude permissions flag) carry over
 * automatically.
 */
export function buildResumeCommand(
  agentId: string,
  sessionId: string
): string | undefined {
  if (!isValidSessionId(agentId, sessionId)) return undefined
  const base = agentCommand(agentId)
  if (base === undefined) return undefined
  return templateById(agentId).resume?.buildCommand(base, sessionId)
}
