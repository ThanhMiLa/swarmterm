import { describe, it, expect } from 'vitest'
import { TerminalWriteQueue } from './terminal-write-queue'

describe('PTY input ordering', () => {
  it('starts the first write immediately, orders text/binary, and leaves other PTYs independent', async () => {
    const q = new TerminalWriteQueue()
    const sent: string[] = []
    let finish!: () => void
    const first = q.write('a', () => { sent.push('text'); return new Promise(resolve => { finish = resolve }) })
    const second = q.write('a', async () => { sent.push('binary') })
    await q.write('b', async () => { sent.push('other') })
    expect(sent).toEqual(['text', 'other'])
    finish()
    await Promise.all([first, second])
    expect(sent).toEqual(['text', 'other', 'binary'])
  })

  it('drops queued old-session input on kill but accepts input for the replacement', async () => {
    const q = new TerminalWriteQueue()
    const sent: string[] = []
    let finish!: () => void
    const first = q.write('a', () => new Promise(resolve => { finish = resolve }))
    const stale = q.write('a', async () => { sent.push('stale') })
    q.cancel('a')
    const fresh = q.write('a', async () => { sent.push('fresh') })
    finish()
    await Promise.all([first, stale, fresh])
    expect(sent).toEqual(['fresh'])
  })

  it('a failed write does not poison later input', async () => {
    const q = new TerminalWriteQueue()
    const failed = q.write('a', async () => { throw new Error('closed') })
    let succeeded = false
    const next = q.write('a', async () => { succeeded = true })
    await expect(failed).rejects.toThrow('closed')
    await next
    expect(succeeded).toBe(true)
  })

  it('replacement input proceeds while an old kernel write remains blocked', async () => {
    const q = new TerminalWriteQueue()
    const sent: string[] = []
    let finishOld!: () => void
    let finishNew!: () => void
    const old = q.write('a', () => new Promise(resolve => { finishOld = resolve }))
    q.cancel('a')
    const fresh = q.write('a', () => {
      sent.push('fresh')
      return new Promise(resolve => { finishNew = resolve })
    })
    expect(sent).toEqual(['fresh'])
    finishOld()
    await old
    const next = q.write('a', async () => { sent.push('next') })
    expect(sent).toEqual(['fresh']) // old completion must not erase the new queue
    finishNew()
    await Promise.all([fresh, next])
    expect(sent).toEqual(['fresh', 'next'])
  })
})
