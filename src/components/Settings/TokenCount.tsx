import type { ReactElement } from 'react'

function formatTokens(count: number): string {
  if (count >= 1_000_000_000) return (count / 1_000_000_000).toFixed(2) + 'B'
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(2) + 'M'
  if (count >= 1_000) return (count / 1_000).toFixed(1) + 'k'
  return count.toLocaleString()
}

/** Reveal the original count in place without resizing the surrounding table. */
export function TokenCount({ count }: { count: number }): ReactElement {
  const exact = count.toLocaleString()

  if (count < 1_000) return <span>{exact}</span>

  return (
    <span
      tabIndex={0}
      aria-label={`${exact} tokens`}
      className="group/token-count relative -m-1.5 inline-block cursor-default whitespace-nowrap rounded p-1.5 tabular-nums outline-none hover:z-20 focus:z-20 focus-visible:ring-1 focus-visible:ring-primary"
    >
      <span
        aria-hidden="true"
        className="inline-block transition-[opacity,transform] duration-200 ease-out group-hover/token-count:scale-95 group-hover/token-count:opacity-0 group-focus/token-count:scale-95 group-focus/token-count:opacity-0 motion-reduce:transition-none"
      >
        {formatTokens(count)}
      </span>
      {/* Right alignment lets the longer value grow into the table, not past its edge. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-0 top-1/2 origin-right -translate-y-1/2 scale-95 rounded bg-card px-1.5 py-1 opacity-0 shadow-sm ring-1 ring-border transition-[opacity,transform] duration-200 ease-out group-hover/token-count:pointer-events-auto group-hover/token-count:scale-100 group-hover/token-count:opacity-100 group-focus/token-count:pointer-events-auto group-focus/token-count:scale-100 group-focus/token-count:opacity-100 motion-reduce:transition-none"
      >
        {exact}
      </span>
    </span>
  )
}
