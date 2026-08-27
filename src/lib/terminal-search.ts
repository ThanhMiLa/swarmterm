/**
 * Pure decisions behind the terminal find widget (`SearchOverlay`).
 *
 * Why validate a regex in the renderer when the addon already throws on it:
 * `@xterm/addon-search` compiles the query with `new RegExp(term, 'g' | 'gi')`
 * inside `_highlightAllMatches` — AFTER it has already wiped the previous
 * highlights and BEFORE it fires `onDidChangeResults` or caches the term. A
 * malformed pattern therefore leaves the widget with no highlights, the OLD
 * active-match selection still on screen, and a stale "k of n" counter. The
 * registry swallows that `SyntaxError` on purpose (a half-typed regex is
 * normal, not exceptional), so the widget has to decide validity up front —
 * and it must decide with the same compile the addon uses, so the two
 * verdicts can never diverge.
 */

export type SearchQueryError = 'invalid-regex'

/**
 * `null` when the query is safe to hand to the search addon, otherwise the
 * reason the overlay should show instead of a match count.
 */
export function validateSearchQuery(query: string, regex: boolean): SearchQueryError | null {
  // The empty query means "clear", never "compile"; with regex off the addon
  // escapes the literal text itself, so nothing can fail there.
  if (!regex || query === '') return null
  try {
    // Flag 'g' only: syntax validity is identical under g/gi (the addon's two
    // choices), whereas 'u'/'v' are stricter and would reject patterns the
    // addon happily compiles (identity escapes like `\-`, a lone `}`).
    new RegExp(query, 'g')
    return null
  } catch {
    return 'invalid-regex'
  }
}

/**
 * "k of n" / "No results" summary. xterm's SearchAddon reports `resultIndex:
 * -1` once the match count exceeds its internal highlight cap (1000 by
 * default — see `ISearchResultChangeEvent`) instead of a real 0-based index,
 * so that case renders the bare total rather than a nonsensical "0 of n".
 *
 * `error` wins over any counts: once the overlay has refused to dispatch a
 * query, whatever numbers it still holds describe the previous search.
 */
export function matchSummary(
  query: string,
  resultIndex: number,
  resultCount: number,
  error?: SearchQueryError | null,
): string {
  if (query === '') return ''
  if (error) return 'Invalid regex'
  if (resultCount === 0) return 'No results'
  if (resultIndex < 0) return `${resultCount} results`
  return `${resultIndex + 1} of ${resultCount}`
}
