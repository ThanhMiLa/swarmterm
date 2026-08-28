/**
 * OSC 133 (FinalTerm) shell-integration marks → a per-pane command state machine.
 *
 * Why this exists: a plain shell pane has no other EXACT "the command is done"
 * signal. The agent-state detector reads output cadence, which is a heuristic;
 * a shell that prints `\e]133;C\e\\` before running a command and `\e]133;D;<exit>\e\\`
 * right after tells us precisely when it started, when it finished, and how it
 * exited. xterm.js has no built-in semantics for OSC 133 — it only hands the
 * payload to a registered handler — so all the meaning lives here, pure, so the
 * gate can prove it. The marks are OPT-IN: the user pastes a snippet into their
 * rc file (see the user guide); Swarmterm never injects anything into the shell.
 *
 * The four marks and how real shells emit them shape the machine rules:
 * - `A` (prompt start) → `prompt`, from anything. From `prompt` it is NOT a
 *   transition: an empty Enter simply redraws the prompt and must cause no churn.
 * - `B` (prompt end / input start) → `input`, only from `prompt`. B is optional —
 *   pwsh has no clean hook pair for it — so the guide snippets omit it and every
 *   other phase ignores it.
 * - `C` (command start) → `running` with the clock stamped, from ANY phase except
 *   `running`. Accepting C without a prior A keeps minimal C/D-only integrations
 *   working; refusing C while running means a stray mark cannot restart the clock.
 * - `D` (command end) → `finished`, ONLY from `running`. bash and zsh print `D;0`
 *   on the very first prompt with no C before it, so a D anywhere else is noise.
 *
 * `last` is carried BY REFERENCE through A/B/C and replaced only by the next D.
 * bash/zsh emit D and A in the same precmd, so a consumer sampling a moment later
 * (git-refresh's debounce, the notification watch in S14.2) sees `prompt`, never
 * `finished` — the identity of `last` is therefore the one-shot "a command
 * finished" signal, and it must survive the A/B/C that follow.
 *
 * `applyShellMark` returns `undefined` for "no transition" so a store can keep the
 * same object and avoid re-rendering subscribers.
 */

export type ShellMark = { kind: 'A' } | { kind: 'B' } | { kind: 'C' } | { kind: 'D'; exitCode?: number }

export type CommandPhase = 'prompt' | 'input' | 'running' | 'finished'

export interface FinishedCommand {
  startedAt: number
  finishedAt: number
  durationMs: number
  exitCode?: number
}

export interface CommandState {
  phase: CommandPhase
  /** When C arrived; present only while running. */
  startedAt?: number
  /** Most recent finished command — carried by reference across A/B/C, replaced only by the next D. */
  last?: FinishedCommand
}

/** A command the user would have walked away from (S14.2 notifies on these). */
export const LONG_COMMAND_MS = 10_000

/**
 * Parse the OSC 133 payload (everything after `133;`). Options after the mark
 * letter (kitty's `aid=…`, VS Code's `cl=…`) are ignored rather than rejected so
 * snippets copied from other terminals keep working. A non-numeric exit code drops
 * the code, not the mark — losing the status is better than losing the transition.
 */
export function parseShellMark(data: string): ShellMark | null {
  const [head, arg] = data.split(';')
  switch (head) {
    case 'A':
      return { kind: 'A' }
    case 'B':
      return { kind: 'B' }
    case 'C':
      return { kind: 'C' }
    case 'D':
      return arg !== undefined && /^\d+$/.test(arg) ? { kind: 'D', exitCode: Number(arg) } : { kind: 'D' }
    default:
      return null
  }
}

/** Advance the machine; `undefined` means "not a transition, keep the previous state object". */
export function applyShellMark(
  state: CommandState | undefined,
  mark: ShellMark,
  nowMs: number
): CommandState | undefined {
  const phase = state?.phase
  // Spread, never `last: state?.last` — an explicit `last: undefined` key would
  // make `toStrictEqual` / shallow diffs see a change where there is none.
  const carry = state?.last === undefined ? {} : { last: state.last }
  switch (mark.kind) {
    case 'A':
      return phase === 'prompt' ? undefined : { phase: 'prompt', ...carry }
    case 'B':
      return phase === 'prompt' ? { phase: 'input', ...carry } : undefined
    case 'C':
      return phase === 'running' ? undefined : { phase: 'running', startedAt: nowMs, ...carry }
    case 'D': {
      if (phase !== 'running' || state?.startedAt === undefined) return undefined
      const exit = mark.exitCode === undefined ? {} : { exitCode: mark.exitCode }
      return {
        phase: 'finished',
        last: { startedAt: state.startedAt, finishedAt: nowMs, durationMs: nowMs - state.startedAt, ...exit }
      }
    }
  }
}

export function isLongCommand(last: FinishedCommand): boolean {
  return last.durationMs >= LONG_COMMAND_MS
}

/** Coarse, human-sized: whole seconds under a minute, `3m 05s`, `1h 02m` — never milliseconds. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (m < 60) return `${m}m ${pad(s % 60)}s`
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`
}

export function formatCommandFinished(last: FinishedCommand): string {
  const d = formatDuration(last.durationMs)
  if (last.exitCode !== undefined && last.exitCode !== 0) return `Command failed (exit ${last.exitCode} · ${d})`
  return `Command finished (${d})`
}
