import { invoke } from '@tauri-apps/api/core'
import { attachTerminal, disposeTerminal, getTerminalBenchmarkHandle } from '@/lib/terminal-registry'
import { useTerminalScrollingStore } from '@/store/terminal-scrolling-store'
import { xtermCore } from '@/lib/terminal-xterm'
import type { CreateTerminalOptions } from '@/tauri/terminal'

export function computeStats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (pct: number) => sorted[Math.min(sorted.length - 1, Math.floor(pct * sorted.length))] ?? 0
  return { count: sorted.length, meanMs: values.reduce((a, b) => a + b, 0) / (values.length || 1),
    minMs: sorted[0] ?? 0, p50Ms: at(.5), p95Ms: at(.95), p99Ms: at(.99), maxMs: sorted.at(-1) ?? 0 }
}

const frame = () => new Promise<number>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Benchmark frames paused: visibility=${document.visibilityState}, focused=${document.hasFocus()}`)), 3000)
  requestAnimationFrame(now => { clearTimeout(timeout); resolve(now) })
})
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
type Fixture = NonNullable<CreateTerminalOptions['benchmarkFixture']>

async function benchmarkCase(root: HTMLElement, mode: 'enhanced' | 'compatibility', count: number, fixture: Fixture, run: number) {
  // In-memory only: the isolated benchmark identifier has no user preferences.
  useTerminalScrollingStore.setState({ scrolling: { mode, sensitivity: 1.5, smoothMouseWheel: true } })
  const paneRoot = document.createElement('div')
  paneRoot.style.cssText = `height:800px;display:grid;grid-template-columns:repeat(${count === 1 ? 1 : 2},1fr);grid-template-rows:repeat(${count === 1 ? 1 : 2},1fr)`
  root.appendChild(paneRoot)
  const ids: string[] = []
  const subscriptions: { dispose(): void }[] = []
  let stopped = false
  let rafId = 0
  const frameTimes: number[] = []
  const drawTimes: number[] = []
  const renderLatencies: number[] = []
  const presentationLatencies: number[] = []
  const dispatchTimes: number[] = []
  const parseLatencies: number[] = []
  const parseToRender: number[] = []
  const trace: { framePhaseMs: number | null; renderMs: number; parsedMs: number | null; dispatchMs: number }[] = []
  let latestFrameTick: number | null = null
  const counters = Array(count).fill(0) as number[]
  const lastWheelParsed = Array(count).fill(0) as number[]
  const positions = Array(count).fill(2000) as number[]
  const readyResolvers: (() => void)[] = []
  const ready = Array.from({ length: count }, () => new Promise<void>(resolve => readyResolvers.push(resolve)))
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    for (let i = 0; i < count; i++) {
      const id = `bench-${mode}-${fixture}-${count}-${run}-${i}`
      ids.push(id)
      const host = document.createElement('div')
      host.style.cssText = 'min-width:0;min-height:0;overflow:hidden'
      paneRoot.appendChild(host)
      attachTerminal(id, host, { agentId: 'terminal', benchmarkFixture: fixture })
      const { term } = getTerminalBenchmarkHandle(id)
      subscriptions.push(term.parser.registerOscHandler(777, data => {
        if (data === 'ready') readyResolvers[i]()
        if (data.startsWith('wheel:')) {
          const [, n, p] = data.split(':')
          counters[i] = Number(n); positions[i] = Number(p)
          lastWheelParsed[i] = performance.now()
        }
        return true
      }))
    }
    await Promise.race([Promise.all(ready), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`Fixture readiness timeout: ${fixture}`)), 15000) })])
    clearTimeout(timeout)
    const handles = ids.map(getTerminalBenchmarkHandle)
    const primary = handles[0]
    if (!fixture.startsWith('tui')) {
      for (const h of handles) h.term.scrollToLine(Math.floor(h.term.buffer.active.baseY / 2))
    }
    await frame(); await frame()
    const started = performance.now()
    const receivedAtStart = handles.map(h => h.output().receivedBytes)
    const messagesAtStart = handles.map(h => h.output().receivedMessages)
    const tick = (now: number) => { if (!stopped) { latestFrameTick = performance.now(); frameTimes.push(now); rafId = requestAnimationFrame(tick) } }
    rafId = requestAnimationFrame(tick)
    for (const h of handles) {
      const render = xtermCore(h.term)._renderService
      if (!render) throw new Error('Terminal renderer was not opened')
      subscriptions.push(render.onRender(() => drawTimes.push(performance.now())))
    }
    const topLine = () => primary.term.buffer.active.getLine(primary.term.buffer.active.viewportY)?.translateToString() ?? ''
    let expectedReports = 0
    const core = xtermCore(primary.term)
    // 120 px has a whole-line component on both native and enhanced paths.
    const deltaY = -120
    for (let event = 0; event < 30; event++) {
      const oldLine = topLine()
      const oldCounter = counters[0]
      const t0 = performance.now()
      const sample = { framePhaseMs: latestFrameTick === null ? null : t0 - latestFrameTick,
        renderMs: 0, parsedMs: null as number | null, dispatchMs: 0 }
      let timer: ReturnType<typeof setTimeout> | undefined
      let subscription: { dispose(): void } | undefined
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          subscription?.dispose()
          reject(new Error(`No visible wheel response: ${mode}/${fixture}/${event}; ` + JSON.stringify({
            viewport: primary.term.buffer.active.viewportY, base: primary.term.buffer.active.baseY,
            counter: counters[0], pending: primary.pendingReports(), protocol: core.coreMouseService.activeProtocol,
            encoding: core.coreMouseService.activeEncoding, cell: core._renderService?.dimensions.css.cell,
            output: primary.output(), keys: Object.keys(core).filter(k => /mouse|render/i.test(k))
          })))
        }, 3000)
        subscription = core._renderService!.onRender(() => {
          const changed = fixture.startsWith('tui') ? counters[0] > oldCounter : topLine() !== oldLine
          if (!changed) return
          subscription?.dispose(); clearTimeout(timer)
          sample.renderMs = performance.now() - t0
          renderLatencies.push(sample.renderMs)
          if (fixture.startsWith('tui')) {
            sample.parsedMs = lastWheelParsed[0] - t0
            parseLatencies.push(sample.parsedMs)
            parseToRender.push(sample.renderMs - sample.parsedMs)
          }
          trace.push(sample)
          // An explicit presentation opportunity, not a claim about physical scanout.
          requestAnimationFrame(() => { presentationLatencies.push(performance.now() - t0); resolve() })
        })
        const rect = core.screenElement!.getBoundingClientRect()
        const wheel = new WheelEvent('wheel', { deltaY, deltaMode: 0,
          clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true })
        // WebKit synthesises deprecated wheelDelta differently from Chromium.
        // Force the modern pixel path for reproducible replay on both engines.
        Object.defineProperty(wheel, 'wheelDeltaY', { value: undefined })
        Object.defineProperty(wheel, 'wheelDeltaX', { value: undefined })
        core.screenElement!.dispatchEvent(wheel)
        sample.dispatchMs = performance.now() - t0
        dispatchTimes.push(sample.dispatchMs)
      })
      if (mode === 'enhanced' && fixture.startsWith('tui')) {
        // Accumulated expected amount is checked after the entire gesture, not per frame.
        expectedReports += Math.abs(deltaY) / core._renderService!.dimensions.css.cell.height * 1.5
      }
      await sleep(8)
    }
    const deadline = performance.now() + 3000
    while (primary.pendingReports() && performance.now() < deadline) await frame()
    await frame(); await frame()
    if (mode === 'enhanced' && fixture.startsWith('tui') && Math.abs(counters[0] - Math.trunc(expectedReports)) > 1) {
      throw new Error(`Lost wheel reports: expected ${Math.trunc(expectedReports)}, received ${counters[0]}`)
    }
    stopped = true
    const duration = performance.now() - started
    const deltas = frameTimes.slice(1).map((t, i) => t - frameTimes[i])
    const outputs = handles.map(h => h.output())
    const streamedBytes = outputs.reduce((sum, m, i) => sum + m.receivedBytes - receivedAtStart[i], 0)
    const streamedMessages = outputs.reduce((sum, m, i) => sum + m.receivedMessages - messagesAtStart[i], 0)
    return {
      mode, fixture, panes: count, run,
      environment: { userAgent: navigator.userAgent, dpr: devicePixelRatio, visibility: document.visibilityState,
        cols: primary.term.cols, rows: primary.term.rows, font: primary.term.options.fontFamily,
        renderers: handles.map(h => h.renderer()) },
      durationMs: duration, rafCadenceMs: computeStats(deltas), actualDrawCalls: drawTimes.length,
      wheelToRenderMs: computeStats(renderLatencies), wheelToPresentationOpportunityMs: computeStats(presentationLatencies),
      wheelDispatchMs: computeStats(dispatchTimes), wheelToTuiParsedMs: computeStats(parseLatencies),
      tuiParsedToRenderMs: computeStats(parseToRender), trace,
      reportsReceived: counters[0], displacement: positions[0] - 2000,
      expectedReports: fixture.startsWith('tui') && mode === 'enhanced' ? Math.trunc(expectedReports) : null,
      output: outputs, streamingMiBPerSecond: streamedBytes / 1048576 / (duration / 1000),
      ipcMessagesPerMiB: streamedBytes ? streamedMessages / (streamedBytes / 1048576) : null
    }
  } finally {
    stopped = true; cancelAnimationFrame(rafId); clearTimeout(timeout)
    subscriptions.forEach(s => s.dispose())
    ids.forEach(disposeTerminal)
    paneRoot.remove()
    await sleep(50)
  }
}

export async function runTerminalBenchmark(): Promise<void> {
  const root = document.getElementById('root')!
  root.style.cssText = 'padding:12px;background:#1f1f1f;color:#ddd;font:13px monospace'
  const status = document.createElement('p')
  root.appendChild(status)
  const results: Awaited<ReturnType<typeof benchmarkCase>>[] = []
  try {
    await document.fonts.ready
    const quick = new URLSearchParams(location.search).has('quick')
    for (const mode of ['compatibility', 'enhanced'] as const) {
      for (const panes of quick ? [1] : [1, 4]) {
        for (const fixture of (quick ? ['static', 'tui'] : ['static', 'stream', 'tui', 'tui-stream']) as Fixture[]) {
          for (let run = 1; run <= (quick ? 1 : 3); run++) {
            status.textContent = `${mode} · ${fixture} · ${panes} pane(s) · run ${run}`
            await invoke('terminal_benchmark_progress', { message: status.textContent })
            results.push(await benchmarkCase(root, mode, panes, fixture, run))
          }
        }
      }
    }
    await invoke('finish_terminal_benchmark', { report: {
      schemaVersion: 1, measuredAt: new Date().toISOString(), runtime: 'Tauri WKWebView; real production registry, PTY and renderer',
      comparison: 'Same-build compatibility vs enhanced; not an unmodified pre-change baseline',
      note: 'Presentation opportunity is the next rAF after actual xterm render; physical scanout is not measured.', results
    } })
  } catch (error) {
    status.textContent = String(error)
    await invoke('finish_terminal_benchmark', { report: { error: String(error), results } })
  }
}
