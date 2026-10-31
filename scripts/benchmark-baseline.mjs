/** Measure a real pre-change checkout with only fixture/measurement hooks added.
 * The snapshot never runs normal app setup or any agent. Current files are untouched. */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const refAt = args.indexOf('--ref')
if (refAt < 0 || !args[refAt + 1]) throw new Error('Supply the pre-change commit: --ref c3b730f')
const reference = execFileSync('git', ['rev-parse', '--verify', `${args[refAt + 1]}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
const snapshot = mkdtempSync(path.join(os.tmpdir(), 'swarmterm-baseline-'))
execFileSync('tar', ['-x', '-C', snapshot], { input: execFileSync('git', ['archive', reference], { cwd: root, maxBuffer: 64 * 1024 * 1024 }) })
const read = file => readFileSync(path.join(snapshot, file), 'utf8')
const write = (file, data) => writeFileSync(path.join(snapshot, file), data)
const replace = (file, needle, replacement) => {
  const content = read(file)
  if (!content.includes(needle)) throw new Error(`Baseline instrumentation does not match ${file}; review it before measuring another version`)
  write(file, content.replace(needle, replacement))
}
if (read('src/lib/terminal-registry.ts').includes('TerminalScrollPolicy')) throw new Error('The requested baseline already contains terminal optimisations')
for (const file of ['src/main.tsx', 'src/lib/terminal-xterm.ts', 'src/lib/terminal-scrolling.ts', 'src/store/terminal-scrolling-store.ts',
  'src/lib/benchmark/terminal-benchmark.ts', 'src-tauri/src/main.rs', 'src-tauri/src/terminal_benchmark.rs', 'scripts/benchmark-cli.mjs']) {
  mkdirSync(path.dirname(path.join(snapshot, file)), { recursive: true })
  cpSync(path.join(root, file), path.join(snapshot, file))
}
replace('src/lib/benchmark/terminal-benchmark.ts', "['compatibility', 'enhanced'] as const", "['compatibility'] as const")
replace('src/lib/benchmark/terminal-benchmark.ts', 'Same-build compatibility vs enhanced; not an unmodified pre-change baseline',
  `Pre-change terminal ${reference}; only isolated fixture and measurement instrumentation added`)
replace('src-tauri/src/terminal_benchmark.rs', 'crate::commands::write_terminal_bytes,', '')
replace('src-tauri/src/terminal_benchmark.rs', 'crate::commands::ack_terminal_output,', '')
replace('src-tauri/src/lib.rs', 'mod window_fit;', 'mod window_fit;\n#[cfg(debug_assertions)]\npub mod terminal_benchmark;')
replace('src-tauri/src/lib.rs', 'pub fn run() {', `pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    if std::env::args().any(|a| a == "--terminal-benchmark") {
        terminal_benchmark::run(context);
        return;
    }`)
replace('src-tauri/src/lib.rs', '.build(tauri::generate_context!())', '.build(context)')
replace('src-tauri/src/pty.rs', 'pub struct CreateTerminalOptions {', 'pub struct CreateTerminalOptions {\n    #[serde(default)]\n    pub benchmark_fixture: Option<String>,')
const currentPty = readFileSync(path.join(root, 'src-tauri/src/pty.rs'), 'utf8')
const fixtureStart = currentPty.indexOf('    if let Some(fixture) = &options.benchmark_fixture {')
const fixtureEnd = currentPty.indexOf('    // Inherit the parent environment', fixtureStart)
if (fixtureStart < 0 || fixtureEnd < 0) throw new Error('Fixture adapter extraction failed')
replace('src-tauri/src/pty.rs', '    // Inherit the parent environment', currentPty.slice(fixtureStart, fixtureEnd) + '    // Inherit the parent environment')
replace('src/tauri/terminal.ts', 'export interface CreateTerminalOptions {', "export interface CreateTerminalOptions {\n  benchmarkFixture?: 'static' | 'stream' | 'tui' | 'tui-stream'")
replace('src/lib/terminal-registry.ts', 'export interface AttachConfig {', "export interface AttachConfig {\n  benchmarkFixture?: 'static' | 'stream' | 'tui' | 'tui-stream'")
replace('src/lib/terminal-registry.ts', 'const entries = new Map<string, Entry>()', `const entries = new Map<string, Entry>()
const measurements = new Map<string, { receivedMessages: number; receivedBytes: number; parsedBytes: number; pendingBytes: number; peakPendingBytes: number; largestChunkBytes: number }>()
export function getTerminalBenchmarkHandle(id: string) {
  const entry = entries.get(id)!
  return { term: entry.term, output: () => ({ ...measurements.get(id)! }),
    renderer: () => entry.host.querySelector('.xterm-screen > canvas') ? 'active' : 'fallback', pendingReports: () => 0 }
}`)
replace('src/lib/terminal-registry.ts', '  const session = new TerminalSession(', `  const measurement = { receivedMessages: 0, receivedBytes: 0, parsedBytes: 0, pendingBytes: 0, peakPendingBytes: 0, largestChunkBytes: 0 }
  measurements.set(id, measurement)
  const session = new TerminalSession(`)
replace('src/lib/terminal-registry.ts', '        term.write(data)', `        const bytes = new TextEncoder().encode(data).length
        measurement.receivedMessages++
        measurement.receivedBytes += bytes
        measurement.pendingBytes = measurement.receivedBytes - measurement.parsedBytes
        measurement.peakPendingBytes = Math.max(measurement.peakPendingBytes, measurement.pendingBytes)
        measurement.largestChunkBytes = Math.max(measurement.largestChunkBytes, bytes)
        term.write(data, () => { measurement.parsedBytes += bytes; measurement.pendingBytes = measurement.receivedBytes - measurement.parsedBytes })`)
replace('src/lib/terminal-registry.ts', '  entries.delete(id)', '  entries.delete(id)\n  measurements.delete(id)')
console.log(`Pre-change benchmark snapshot: ${snapshot}\nSource commit: ${reference}`)
execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: snapshot, stdio: 'inherit' })
if (args.includes('--prepare-only')) {
  execFileSync('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml'], {
    cwd: snapshot, stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: path.join(root, 'src-tauri/target') }
  })
  console.log(`Prepared snapshot: ${snapshot}`)
  process.exit(0)
}
const reportAt = args.indexOf('--report')
const report = path.resolve(root, reportAt >= 0 ? args[reportAt + 1] : 'artifacts/terminal-benchmark-baseline.json')
const result = spawnSync(process.execPath, ['scripts/benchmark-cli.mjs', '--report', report, ...(args.includes('--quick') ? ['--quick'] : [])], {
  cwd: snapshot, stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: path.join(root, 'src-tauri/target') }
})
process.exitCode = result.status ?? 1
