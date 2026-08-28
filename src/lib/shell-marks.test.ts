import { describe, expect, it } from 'vitest'
import {
  LONG_COMMAND_MS,
  applyShellMark,
  formatCommandFinished,
  formatDuration,
  isLongCommand,
  parseShellMark,
  type CommandState,
  type FinishedCommand
} from './shell-marks'

describe('parseShellMark', () => {
  it('parses the four FinalTerm marks', () => {
    expect(parseShellMark('A')).toEqual({ kind: 'A' })
    expect(parseShellMark('B')).toEqual({ kind: 'B' })
    expect(parseShellMark('C')).toEqual({ kind: 'C' })
    expect(parseShellMark('D')).toEqual({ kind: 'D' })
  })

  it('reads the exit code after D', () => {
    expect(parseShellMark('D;0')).toEqual({ kind: 'D', exitCode: 0 })
    expect(parseShellMark('D;130')).toEqual({ kind: 'D', exitCode: 130 })
  })

  it('ignores options after the mark letter (kitty / VS Code extensions)', () => {
    expect(parseShellMark('A;aid=1;cl=m')).toEqual({ kind: 'A' })
    expect(parseShellMark('C;')).toEqual({ kind: 'C' })
    expect(parseShellMark('D;1;aid=1')).toEqual({ kind: 'D', exitCode: 1 })
  })

  it('drops a non-numeric exit code instead of failing the mark', () => {
    expect(parseShellMark('D;junk')).toEqual({ kind: 'D' })
    expect(parseShellMark('D;-1')).toEqual({ kind: 'D' })
    expect(parseShellMark('D;')).toEqual({ kind: 'D' })
  })

  it('rejects anything that is not one of the four marks', () => {
    expect(parseShellMark('')).toBeNull()
    expect(parseShellMark('a')).toBeNull()
    expect(parseShellMark('E')).toBeNull()
    expect(parseShellMark('P;k=i')).toBeNull()
    expect(parseShellMark('AB')).toBeNull()
  })
})

const prompt: CommandState = { phase: 'prompt' }
const running = (startedAt: number): CommandState => ({ phase: 'running', startedAt })

describe('applyShellMark', () => {
  it('A opens a prompt from nothing and from any other phase', () => {
    expect(applyShellMark(undefined, { kind: 'A' }, 0)).toEqual({ phase: 'prompt' })
    expect(applyShellMark(running(5), { kind: 'A' }, 9)).toEqual({ phase: 'prompt' })
    expect(applyShellMark({ phase: 'input' }, { kind: 'A' }, 9)).toEqual({ phase: 'prompt' })
  })

  it('A on an existing prompt is not a transition (an empty Enter redraws the prompt)', () => {
    expect(applyShellMark(prompt, { kind: 'A' }, 1)).toBeUndefined()
  })

  it('B moves prompt → input and is otherwise ignored', () => {
    expect(applyShellMark(prompt, { kind: 'B' }, 1)).toEqual({ phase: 'input' })
    expect(applyShellMark(undefined, { kind: 'B' }, 1)).toBeUndefined()
    expect(applyShellMark(running(5), { kind: 'B' }, 9)).toBeUndefined()
    expect(applyShellMark({ phase: 'input' }, { kind: 'B' }, 9)).toBeUndefined()
  })

  it('C starts running from prompt, input or nothing, stamping startedAt', () => {
    expect(applyShellMark(prompt, { kind: 'C' }, 100)).toEqual({ phase: 'running', startedAt: 100 })
    expect(applyShellMark({ phase: 'input' }, { kind: 'C' }, 100)).toEqual({ phase: 'running', startedAt: 100 })
    expect(applyShellMark(undefined, { kind: 'C' }, 100)).toEqual({ phase: 'running', startedAt: 100 })
  })

  it('C while running is ignored so a stray mark cannot restart the clock', () => {
    expect(applyShellMark(running(100), { kind: 'C' }, 200)).toBeUndefined()
  })

  it('D closes a running command with exit code, duration and finishedAt', () => {
    expect(applyShellMark(running(100), { kind: 'D', exitCode: 1 }, 42_100)).toEqual({
      phase: 'finished',
      last: { startedAt: 100, finishedAt: 42_100, durationMs: 42_000, exitCode: 1 }
    })
    expect(applyShellMark(running(100), { kind: 'D' }, 600)).toEqual({
      phase: 'finished',
      last: { startedAt: 100, finishedAt: 600, durationMs: 500 }
    })
  })

  it('D outside running is ignored — bash/zsh print D;0 on the very first prompt', () => {
    expect(applyShellMark(undefined, { kind: 'D', exitCode: 0 }, 1)).toBeUndefined()
    expect(applyShellMark(prompt, { kind: 'D', exitCode: 0 }, 1)).toBeUndefined()
    expect(applyShellMark({ phase: 'input' }, { kind: 'D', exitCode: 0 }, 1)).toBeUndefined()
    const finished = applyShellMark(running(0), { kind: 'D', exitCode: 0 }, 5)
    expect(applyShellMark(finished, { kind: 'D', exitCode: 0 }, 6)).toBeUndefined()
  })

  it('the last finished record rides along A/B/C by reference until the next D replaces it', () => {
    const finished = applyShellMark(running(0), { kind: 'D', exitCode: 0 }, 5)!
    const p = applyShellMark(finished, { kind: 'A' }, 6)!
    expect(p).toEqual({ phase: 'prompt', last: finished.last })
    expect(p.last).toBe(finished.last)
    const i = applyShellMark(p, { kind: 'B' }, 7)!
    expect(i).toEqual({ phase: 'input', last: finished.last })
    expect(i.last).toBe(finished.last)
    const r = applyShellMark(i, { kind: 'C' }, 8)!
    expect(r).toEqual({ phase: 'running', startedAt: 8, last: finished.last })
    expect(r.last).toBe(finished.last)
    const f2 = applyShellMark(r, { kind: 'D', exitCode: 2 }, 20)!
    expect(f2.last).not.toBe(finished.last)
    expect(f2.last).toEqual({ startedAt: 8, finishedAt: 20, durationMs: 12, exitCode: 2 })
  })

  it('A on a prompt that carries a last record is still not a transition', () => {
    const finished = applyShellMark(running(0), { kind: 'D' }, 5)!
    const p = applyShellMark(finished, { kind: 'A' }, 6)!
    expect(applyShellMark(p, { kind: 'A' }, 7)).toBeUndefined()
  })

  it('never writes explicit undefined keys (toStrictEqual)', () => {
    expect(applyShellMark(undefined, { kind: 'A' }, 0)).toStrictEqual({ phase: 'prompt' })
    expect(applyShellMark(prompt, { kind: 'C' }, 1)).toStrictEqual({ phase: 'running', startedAt: 1 })
    expect(applyShellMark(running(1), { kind: 'D' }, 2)).toStrictEqual({
      phase: 'finished',
      last: { startedAt: 1, finishedAt: 2, durationMs: 1 }
    })
  })
})

describe('durations and copy', () => {
  it('formatDuration: sub-second, whole seconds (floored), minutes with zero-padded seconds, hours', () => {
    expect(formatDuration(400)).toBe('<1s')
    expect(formatDuration(42_000)).toBe('42s')
    expect(formatDuration(42_999)).toBe('42s')
    expect(formatDuration(185_000)).toBe('3m 05s')
    expect(formatDuration(3_720_000)).toBe('1h 02m')
  })

  it('isLongCommand is inclusive at LONG_COMMAND_MS', () => {
    const at = (durationMs: number): FinishedCommand => ({ startedAt: 0, finishedAt: durationMs, durationMs })
    expect(LONG_COMMAND_MS).toBe(10_000)
    expect(isLongCommand(at(LONG_COMMAND_MS))).toBe(true)
    expect(isLongCommand(at(LONG_COMMAND_MS - 1))).toBe(false)
  })

  it('formatCommandFinished distinguishes success, failure and an unknown exit', () => {
    expect(formatCommandFinished({ startedAt: 0, finishedAt: 42_000, durationMs: 42_000, exitCode: 0 }))
      .toBe('Command finished (42s)')
    expect(formatCommandFinished({ startedAt: 0, finishedAt: 42_000, durationMs: 42_000, exitCode: 1 }))
      .toBe('Command failed (exit 1 · 42s)')
    expect(formatCommandFinished({ startedAt: 0, finishedAt: 185_000, durationMs: 185_000 }))
      .toBe('Command finished (3m 05s)')
  })
})
