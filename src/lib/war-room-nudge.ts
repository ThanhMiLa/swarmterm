/**
 * War Room delivery texts + flush ordering. Pure — the store queues
 * PendingDeliveries per terminal and the delivery wiring decides WHEN
 * (sustained idle); this module decides WHAT gets typed.
 *
 * Probe bodies deliberately never appear here: only a short nudge is typed
 * into the agent's terminal and the content stays in the MCP inbox, so
 * cross-agent chatter can't bloat an agent's context window.
 */

import type { AgentEngineState } from '@/lib/agent-state/types'

/** Idle must hold this long before typing into a pane. Deliberately above the
 *  activity tracker's 1100ms so a brief pause mid-turn never reads as "done". */
export const NUDGE_IDLE_MS = 3000

export interface PendingDelivery {
  fromName: string
  mode: 'probe' | 'execute'
  /** Full prompt for execute deliveries; probes carry no body. */
  content?: string
}

export function buildNudgeText(fromNames: string[]): string {
  const unique = [...new Set(fromNames)]
  const who = unique.join(', ')
  if (fromNames.length === 1) {
    return `[War Room] New message from ${who}. Call the war_room.read_inbox tool to read it, then reply with war_room.send.`
  }
  return `[War Room] ${fromNames.length} new messages (from ${who}). Call the war_room.read_inbox tool to read them, then reply with war_room.send.`
}

export function buildIntroText(roomName: string, peerNames: string[]): string {
  const with_ = peerNames.length > 0 ? ` with ${peerNames.join(', ')}` : ''
  return (
    `[War Room] You joined Swarmterm's War Room "${roomName}"${with_}. ` +
    `First call war_room.list_peers now — that confirms your connection (until then ` +
    `peers see you as pending and cannot message you). ` +
    `Tools: war_room.list_peers (who is here), war_room.send (mode "probe" to message a peer, ` +
    `mode "execute" to hand a peer a prompt their terminal will run), war_room.read_inbox ` +
    `(read messages sent to you — you will be nudged). ` +
    // The human is a peer like any other, so agents must be told the id and
    // that this one peer has no terminal to be nudged in.
    `The peer "Moderator" (terminalId "__moderator__") is the human user driving Swarmterm: ` +
    `war_room.send to them when you need a decision. They read everything in the panel and ` +
    `have no terminal, so never send them mode "execute". ` +
    `Coordinate through these tools and keep message bodies out of the terminal.`
  )
}

/** Paste payloads for one idle window: executes verbatim in arrival order,
 *  then a single merged nudge covering every queued probe. */
export function flushQueue(queue: PendingDelivery[]): string[] {
  const out: string[] = []
  for (const d of queue) {
    if (d.mode === 'execute' && d.content !== undefined) out.push(d.content)
  }
  const probes = queue.filter((d) => d.mode === 'probe')
  if (probes.length > 0) out.push(buildNudgeText(probes.map((d) => d.fromName)))
  return out
}

/**
 * How long after the last keystroke a focused pane still counts as "being
 * typed in". Deliberately well above NUDGE_IDLE_MS: the two guards answer
 * different questions (has the pty stopped talking? has the user stopped
 * typing?) and a pane is routinely output-idle while the user is mid-sentence.
 */
export const TYPING_QUIET_MS = 6000

export interface TypingSnapshot {
  /** Is this the pane the keyboard currently goes to? */
  focused: boolean
  /** ms epoch of the last user input, or undefined if never typed in. */
  lastKeyAt: number | undefined
  /** A line has been typed here and not yet submitted or abandoned. */
  dirty: boolean
}

/** Why a queued delivery is being withheld from a pane. Order of precedence
 *  is blocked → working → typing: the agent reasons come first because a
 *  flush is body writes PLUS an Enter, and on a permission prompt that Enter
 *  is an approval — the user clearing their own typing must not release it. */
export type HoldReason = 'agent-blocked' | 'agent-working' | 'typing'

export interface DeliverySnapshot extends TypingSnapshot {
  /** Raw engine state for this pane; undefined when the engine has no entry
   *  (plain shell, no manifest, or cleared on kill). Never `displayState` —
   *  the seen-bit behind `done` is a UI concern, not a safety signal. */
  agentState?: AgentEngineState
}

/**
 * Why typing into this pane right now would be wrong — or null if it's safe.
 * There is no maximum hold on purpose — force-delivering after N seconds would
 * reintroduce exactly the corruption this guards against, just more rarely.
 * The escape for the typing reason is the user-facing "Deliver now"
 * affordance, which clears the typing signal instead of bypassing this rule;
 * the agent reasons have no escape and release only when the engine says idle.
 */
export function deliveryHoldReason(s: DeliverySnapshot, now: number): HoldReason | null {
  // A permission/question prompt is output-idle, so the clock gate alone
  // would type into it; and a silent long tool call is output-idle too.
  // `unknown` deliberately falls through to the clock — the engine has no
  // opinion, and the pre-Đ2 behaviour is the right fallback.
  if (s.agentState === 'blocked') return 'agent-blocked'
  if (s.agentState === 'working') return 'agent-working'
  // Unfocused-but-dirty still holds: the line survives losing focus.
  if (s.dirty) return 'typing'
  if (!s.focused) return null
  // Safety net for input the dirty flag can miss — a TUI consuming keystrokes
  // through a path `onData` does not represent.
  return s.lastKeyAt !== undefined && now - s.lastKeyAt < TYPING_QUIET_MS ? 'typing' : null
}

/** Boolean view of `deliveryHoldReason` for callers that only need yes/no. */
export function shouldDeferDelivery(s: DeliverySnapshot, now: number): boolean {
  return deliveryHoldReason(s, now) !== null
}

/** UI copy per reason. `releasable` = "Deliver now" may be offered: it clears
 *  the typing signal, which is meaningless against an agent hold — and a real
 *  bypass would press Enter on the very prompt the agent is waiting on. */
export function holdReasonCopy(reason: HoldReason): { title: string; releasable: boolean } {
  switch (reason) {
    case 'typing':
      return { title: "Held because you're typing here. Click to deliver now.", releasable: true }
    case 'agent-blocked':
      return {
        title: 'Held — the agent is waiting on a permission or question prompt. Delivers once it is idle.',
        releasable: false
      }
    case 'agent-working':
      return { title: 'Held — the agent is still working. Delivers once it is idle.', releasable: false }
  }
}
