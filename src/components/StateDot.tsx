import type { ReactElement } from 'react'
import { stateAgeTitle } from '@/lib/state-age'
import { cn } from '@/lib/utils'

/**
 * Agent-state dot: red demands input, green waits to be looked at, yellow is
 * the same "busy" the ActivityDot shows. Colors are VS Code Dark Modern ANSI
 * (brightRed / brightGreen) so the chrome matches the terminal interior.
 * idle/unknown render nothing — callers decide fallbacks via paneDot().
 */
const DOT: Record<'blocked' | 'done' | 'working', { className: string; label: string }> = {
  blocked: { className: 'bg-[#F14C4C]', label: 'Blocked — needs your input' },
  done: { className: 'bg-[#23D18B]', label: 'Done — finished while you were away' },
  working: { className: 'bg-activity', label: 'Working' }
}

export function StateDot({
  state,
  sinceMs,
  className
}: {
  state: 'blocked' | 'done' | 'working'
  /** Store stamp; omitted by callers without a per-pane entry (workspace rollup dot). */
  sinceMs?: number
  className?: string
}): ReactElement {
  const { className: color, label } = DOT[state]
  // A native tooltip is read by the browser when it shows (~0.5–1 s after
  // hover), not at render — so the title is computed once here and refreshed
  // on mouseenter. No ticker, no re-render, always fresh when actually seen.
  // Date.now() in render is impure but only feeds this string.
  const title = (): string =>
    sinceMs === undefined ? label : stateAgeTitle(state, sinceMs, Date.now())
  return (
    <span
      aria-label={label}
      title={title()}
      onMouseEnter={(e) => {
        e.currentTarget.title = title()
      }}
      className={cn('h-2 w-2 shrink-0 rounded-full', color, className)}
    />
  )
}
