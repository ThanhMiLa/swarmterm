/** Compare medians of repeated native runs against an actual pre-change checkout. */
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`)
  return args[index + 1]
}
const baseline = JSON.parse(readFileSync(option('--baseline'), 'utf8'))
const after = JSON.parse(readFileSync(option('--after'), 'utf8'))
if (baseline.error || after.error) throw new Error('A benchmark failed; incomplete runs cannot establish acceptance')
if (!baseline.comparison?.startsWith('Pre-change terminal ')) throw new Error('Supply a genuine pre-change baseline, not same-build compatibility')
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const cases = []
for (const panes of [1, 4]) {
  for (const fixture of ['static', 'stream', 'tui', 'tui-stream']) {
    const previous = baseline.results.filter(r => r.panes === panes && r.fixture === fixture)
    const current = after.results.filter(r => r.mode === 'enhanced' && r.panes === panes && r.fixture === fixture)
    if (previous.length !== 3 || current.length !== 3) throw new Error(`Need three runs for ${panes}/${fixture}`)
    const beforeMs = median(previous.map(r => r.wheelToRenderMs.p95Ms))
    const afterMs = median(current.map(r => r.wheelToRenderMs.p95Ms))
    const beforeMiBps = median(previous.map(r => r.streamingMiBPerSecond))
    const afterMiBps = median(current.map(r => r.streamingMiBPerSecond))
    cases.push({ panes, fixture, beforeMs, afterMs, changePercent: (afterMs / beforeMs - 1) * 100,
      beforeMiBps, afterMiBps,
      streamingChangePercent: fixture.includes('stream') ? (afterMiBps / beforeMiBps - 1) * 100 : null })
  }
}
const results = after.results
const gates = {
  quietP95WithinTenPercent: cases.filter(c => c.fixture === 'static').every(c => c.changePercent <= 10 + 1e-6),
  stressedP95ImprovedTwentyFivePercent: cases.some(c => c.fixture.includes('stream') && c.changePercent <= -25),
  streamingRateWithinFifteenPercent: cases.filter(c => c.streamingChangePercent !== null).every(c => c.streamingChangePercent >= -15),
  enhancedWheelQuantitiesPreserved: results.filter(r => r.expectedReports !== null).every(r => Math.abs(r.reportsReceived - r.expectedReports) <= 1),
  chunksAtMostEightKiB: results.every(r => r.output.every(o => o.largestChunkBytes <= 8192)),
  pendingOutputAtMost256KiB: results.every(r => r.output.every(o => o.peakPendingBytes <= 262144)),
  webglActive: results.every(r => r.environment.renderers.every(s => s === 'active')),
  visibleWindow: [baseline, after].every(r => r.nativeWindow?.visible && !r.nativeWindow?.minimized)
}
const report = { measuredAt: after.measuredAt, baseline: baseline.comparison, mode: 'enhanced',
  aggregation: 'median of three per-run p95 render latencies; next-rAF is not physical scanout',
  note: 'Streaming rate is achieved fixture rate, not maximum parser throughput. OS scheduling and millisecond timer quantisation affect small differences.',
  cases, gates, accepted: Object.values(gates).every(Boolean) }
for (const c of cases) console.log(`${c.panes} pane(s) ${c.fixture}: ${c.beforeMs.toFixed(2)} → ${c.afterMs.toFixed(2)} ms (${c.changePercent.toFixed(1)}%)`)
for (const [gate, passed] of Object.entries(gates)) console.log(`${passed ? 'PASS' : 'FAIL'} ${gate}`)
const outAt = args.indexOf('--report')
if (outAt >= 0) writeFileSync(args[outAt + 1], JSON.stringify(report, null, 2) + '\n')
process.exitCode = report.accepted ? 0 : 2
