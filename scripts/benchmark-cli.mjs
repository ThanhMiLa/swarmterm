/** Run the real WKWebView/PTY benchmark. Parser-only Node timings are not visual latency. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const at = args.indexOf('--report')
const reportPath = path.resolve(root, at >= 0 ? args[at + 1] : 'artifacts/terminal-benchmark-latest.json')
const startedAt = Date.now()
mkdirSync(path.dirname(reportPath), { recursive: true })
let server
let cargo
const stop = child => { if (child && child.exitCode === null) { try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() } } }
let log = ''
let sourceReloaded = false
const capture = data => {
  const chunk = data.toString()
  if (/page reload|hmr update/.test(chunk)) sourceReloaded = true
  log = (log + chunk).slice(-16000)
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

try {
  if (process.platform === 'win32') throw new Error('The raw-input fixture currently requires macOS/Linux; Windows needs a separate smoke test.')
  const responds = async () => {
    try {
      const r = await fetch('http://localhost:1420/src/main.tsx', { signal: AbortSignal.timeout(800) })
      return r.ok && (await r.text()).includes('terminalBenchmark')
    } catch { return false }
  }
  // A pre-existing server may belong to another checkout (especially baseline).
  // Require our own successful bind rather than silently measuring its code.
  let serverReady = false
  server = spawn('npm', ['run', 'dev', '--', '--force', '--strictPort'], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', data => { capture(data); if (data.toString().includes('Local:')) serverReady = true })
  server.stderr.on('data', capture)
  let moduleReady = false
  for (let i = 0; i < 80 && !moduleReady; i++) {
    if (server.exitCode !== null) throw new Error(`Vite could not bind port 1420; stop the existing dev server before benchmarking: ${log}`)
    if (serverReady) moduleReady = await responds()
    if (moduleReady) break
    await delay(100)
  }
  if (!moduleReady) throw new Error(`Vite did not become ready: ${log}`)
  console.log(`Running native Tauri benchmark on ${os.type()} ${os.release()} ${os.arch()}; report: ${reportPath}`)
  cargo = spawn('cargo', ['run', '--manifest-path', 'src-tauri/Cargo.toml', '--', '--terminal-benchmark'], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SWARMTERM_BENCHMARK: '1', SWARMTERM_BENCHMARK_REPORT: reportPath,
      ...(args.includes('--quick') ? { SWARMTERM_BENCHMARK_QUICK: '1' } : {}) }
  })
  cargo.stdout.on('data', capture); cargo.stderr.on('data', data => { capture(data); process.stderr.write(data) })
  const watchdog = setTimeout(() => stop(cargo), 240000)
  const code = await new Promise((resolve, reject) => { cargo.once('error', reject); cargo.once('exit', resolve) })
  clearTimeout(watchdog)
  if (sourceReloaded) throw new Error('Source changed during the benchmark (Vite reload/HMR). Discard this run and repeat without edits.')
  if (code !== 0 || !existsSync(reportPath) || statSync(reportPath).mtimeMs < startedAt) throw new Error(`Benchmark exited (${code}): ${log}`)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  if (report.error) throw new Error(report.error)
  console.log(report.comparison)
  for (const r of report.results) {
    console.log(`${r.mode.padEnd(13)} ${r.fixture.padEnd(10)} ${r.panes} pane(s) #${r.run}: ` +
      `wheel→render p95=${r.wheelToRenderMs.p95Ms.toFixed(2)}ms, ` +
      `rAF p95=${r.rafCadenceMs.p95Ms.toFixed(2)}ms, ` +
      `renderer=${r.environment.renderers.join(',')}, reports=${r.reportsReceived}`)
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally { stop(cargo); stop(server) }
