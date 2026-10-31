/** Serialise text and binary writes per PTY without delaying the first input.
 * Cancellation drops queued writes before a terminal id is reused. */
export class TerminalWriteQueue {
  private queues = new Map<string, { run: () => Promise<void>; resolve: () => void; reject: (e: unknown) => void }[]>()

  write(id: string, run: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(id)
      const job = { run, resolve, reject }
      if (queue) queue.push(job)
      else {
        this.queues.set(id, [job])
        void this.drain(id)
      }
    })
  }

  cancel(id: string): void {
    const queue = this.queues.get(id)
    if (!queue) return
    for (const job of queue.splice(1)) job.resolve()
    // An old kernel write may remain blocked after kill. A replacement PTY
    // has its own writer and must not wait for that session's in-flight call.
    this.queues.delete(id)
  }

  private async drain(id: string): Promise<void> {
    const queue = this.queues.get(id)!
    while (queue.length) {
      const job = queue[0]
      try { await job.run(); job.resolve() } catch (error) { job.reject(error) }
      queue.shift()
    }
    if (this.queues.get(id) === queue) this.queues.delete(id)
  }
}
