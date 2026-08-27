import type { AgentPaneState } from '@/lib/agent-state/rollup'
import { agentNotificationsEnabled, type NotificationPrefs } from '@/lib/notification-pref'

export type NotificationKind = 'attention' | 'completion'

export interface AgentStateTransition {
  terminalId: string
  kind: NotificationKind | 'removed'
}

/**
 * Classify what changed between two agent-state snapshots. Relies on the
 * store's dedupe (identical state never republished as a new object): a
 * reference-equal entry cannot carry a transition. `unknown → idle` is not a
 * completion (spawn settling), and the markSeen flip is not a transition.
 */
export function diffAgentStates(
  prev: Record<string, AgentPaneState>,
  next: Record<string, AgentPaneState>
): AgentStateTransition[] {
  const out: AgentStateTransition[] = []
  for (const [terminalId, cur] of Object.entries(next)) {
    const old = prev[terminalId]
    if (old === cur) continue
    if (cur.state === 'blocked' && old?.state !== 'blocked') {
      out.push({ terminalId, kind: 'attention' })
    } else if (
      cur.state === 'idle' &&
      !cur.seen &&
      (old?.state === 'working' || old?.state === 'blocked')
    ) {
      out.push({ terminalId, kind: 'completion' })
    }
  }
  for (const terminalId of Object.keys(prev)) {
    if (!(terminalId in next)) out.push({ terminalId, kind: 'removed' })
  }
  return out
}

export interface PendingNotification {
  terminalId: string
  kind: NotificationKind
  agentId: string
}

export interface FireContext {
  current: AgentPaneState | undefined
  paneWatched: boolean
  windowFocused: boolean
  prefs: NotificationPrefs
}

export interface FireVerdict {
  sound: boolean
  system: boolean
}

const DROP: FireVerdict = { sound: false, system: false }

/**
 * Fire-time re-validation, ~1 s after the transition: a blocked flash that
 * resolved itself, a pane the user has since looked at, or a dead terminal
 * must not notify. The banner additionally requires the window to be
 * unfocused AT THIS INSTANT — inside the app the chime alone is the signal.
 */
export function resolveFire(pending: PendingNotification, ctx: FireContext): FireVerdict {
  const { current } = ctx
  if (current === undefined) return DROP
  if (pending.kind === 'attention' && current.state !== 'blocked') return DROP
  if (pending.kind === 'completion' && !(current.state === 'idle' && !current.seen)) return DROP
  if (ctx.paneWatched) return DROP
  if (!agentNotificationsEnabled(ctx.prefs, pending.agentId)) return DROP
  return { sound: ctx.prefs.sound, system: ctx.prefs.system && !ctx.windowFocused }
}

export function notificationCopy(
  kind: NotificationKind,
  agentName: string,
  paneTitle: string
): { title: string; body: string } {
  return {
    title: kind === 'attention' ? `${agentName} needs your input` : `${agentName} finished`,
    body: paneTitle
  }
}

export interface FiredNotification {
  kind: NotificationKind
  agentName: string
  paneTitle: string
}

export interface CoalescedNotification {
  kind: NotificationKind
  title: string
  body: string
}

/**
 * Fold every notification that survived fire-time re-validation in one batch
 * into ONE chime kind + ONE banner. A single entry is byte-identical to
 * `notificationCopy` so today's banners never change. With several, attention
 * outranks completion for the tone (a pane waiting on the user matters more
 * than one that finished) and is listed first in the copy; each kind becomes
 * one title segment, pluralised by agent name when every pane in the segment
 * belongs to the same CLI ("2 Claude Code panes finished") and generically
 * otherwise ("3 agents finished"). Empty pane titles carry no information in a
 * group, so they are dropped from the body — only the single-entry path keeps
 * an empty body, for parity with `notificationCopy`.
 */
export function coalesceNotifications(fired: readonly FiredNotification[]): CoalescedNotification | null {
  const only = fired.length === 1 ? fired[0] : undefined
  if (only !== undefined) return { kind: only.kind, ...notificationCopy(only.kind, only.agentName, only.paneTitle) }
  if (fired.length === 0) return null
  const attention = fired.filter((f) => f.kind === 'attention')
  const completion = fired.filter((f) => f.kind === 'completion')
  const segments = [attention, completion].filter((g) => g.length > 0).map(segmentTitle)
  return {
    kind: attention.length > 0 ? 'attention' : 'completion',
    title: segments.join(' · '),
    body: [...attention, ...completion]
      .map((f) => f.paneTitle)
      .filter((t) => t !== '')
      .join(' · ')
  }
}

// Only ever called with a non-empty, single-kind group — the caller's
// `filter((g) => g.length > 0)` guarantees `group[0]` exists.
function segmentTitle(group: readonly FiredNotification[]): string {
  const first = group[0]
  if (group.length === 1) return notificationCopy(first.kind, first.agentName, '').title
  const sameAgent = group.every((f) => f.agentName === first.agentName)
  const subject = sameAgent ? `${group.length} ${first.agentName} panes` : `${group.length} agents`
  return first.kind === 'attention' ? `${subject} need your input` : `${subject} finished`
}
