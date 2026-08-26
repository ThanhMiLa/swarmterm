import type { ReactElement } from 'react'
import { attentionCount, collectAttentionPanes } from '@/lib/attention'
import { jumpToAttention } from '@/lib/attention-jump'
import { cn } from '@/lib/utils'
import { useAgentStateStore } from '@/store/agent-state-store'
import { useAppStore } from '@/store/app-store'

/**
 * Cross-workspace count of panes the user should look at (blocked + done),
 * sat in the navbar header. Renders nothing when both are zero so the header
 * stays quiet in the common case. Clicking jumps like Mod+Shift+J — the ring
 * is computed once in `attention-jump.ts`, not duplicated here. The navbar is
 * a `data-focus-return` region, so focus lands on the revealed pane right
 * after the click.
 */
export function AttentionBadge(): ReactElement | null {
  const workspaces = useAppStore((s) => s.workspaces)
  const byId = useAgentStateStore((s) => s.byId)
  const { blocked, done } = attentionCount(collectAttentionPanes(workspaces, byId))
  if (blocked === 0 && done === 0) return null
  return (
    <span className="flex items-center gap-1">
      {blocked > 0 && <Pill count={blocked} tone="blocked" />}
      {done > 0 && <Pill count={done} tone="done" />}
    </span>
  )
}

// Hex colours are the same VS Code Dark Modern brightRed / brightGreen as
// StateDot — the counter must read as "how many of those dots" at a glance.
const TONE = {
  blocked: { className: 'bg-[#F14C4C] text-white', title: 'pane(s) need your input' },
  done: { className: 'bg-[#23D18B] text-black', title: 'pane(s) finished while you were away' }
} as const

function Pill({ count, tone }: { count: number; tone: keyof typeof TONE }): ReactElement {
  const { className, title } = TONE[tone]
  return (
    <button
      type="button"
      // Focus must stay with the terminal (see CLAUDE.md "Keyboard focus").
      tabIndex={-1}
      title={`${count} ${title} — click or press Mod+Shift+J to jump`}
      onClick={() => jumpToAttention()}
      className={cn(
        'min-w-[18px] rounded-full px-1.5 text-[10px] font-semibold leading-4 tabular-nums',
        className
      )}
    >
      {count}
    </button>
  )
}
