# Terminal scrolling: implementation and acceptance

Swarmterm keeps React, Tauri and pinned `@xterm/xterm` 6.0.0. These changes apply
to every terminal, shell and CLI. They do not use a Codex-specific input path.

**Current scope, confirmed by the user on 2026-10-31:** keep the present roughly
60 fps experience. Defer 120 Hz/high-refresh work and further performance targets
to a later development phase. The current implementation does not enable a
high-refresh WebKit SPI, change system preferences, or expose a 120 Hz switch.

## Settings

Settings → Terminal → Scrolling applies immediately to running panes:

- **Enhanced** (default): sensitivity 1.5, precise TUI wheel quantities, native
  xterm mouse encodings and optional 100 ms animation for physical mouse wheels.
- **Compatibility**: native xterm wheel handling, sensitivity 1, animation off.
- Sensitivity: 0.25–3, in 0.25 steps. Smooth mouse wheel can be disabled separately.

Preferences persist under `swarmterm:terminal-scrolling`. Trackpad gestures use
xterm's device classification; the application does not add its own inertia.
Normal scrollback remains xterm's viewport, while mouse-enabled TUIs receive
normalised line counts. A TUI ultimately decides how those reports move content.

## Reviewed fixes

- PTY input writes use a per-writer mutex on a blocking worker. They release the
  global terminal map before writing, leaving output ACK, resize and kill available
  when a child stops reading stdin. Text and binary writes are ordered per PTY.
  Session tokens prevent queued input reaching a replacement session with the same ID.
  A replacement also starts a separate input queue, so an old blocked kernel write
  cannot hold up its first keystrokes.
- Mouse reports use xterm's own protocol restrictions, measured coordinates and
  encoders, including legacy binary input and SGR pixel coordinates. Mouse input
  stays in its source pane and does not activate keyboard broadcast or typing state.
- The enhanced TUI path retains fractional deltas, sends a leading batch immediately
  and limits work to 32 reports per animation frame. Buffer/protocol/encoding changes,
  reset, respawn and disposal discard obsolete queued input. Repeated activation of
  the same protocol does not discard valid input.
- Parsed output is split at UTF-8 boundaries into at most 8 KiB. ACKs count actual
  parsed bytes, with a 32 KiB threshold or independent 16 ms timer. Rust permits at
  most 256 KiB of unacknowledged decoded output per session and wakes waiters on kill.
  Exit waits until the final frontend parser callbacks have completed.
  ACKs have one request in flight; confirmed byte counts advance only after IPC
  succeeds. Failed requests retry the latest cumulative parsed count after
  16/64/256 ms, including when the full window prevents further output arriving.
  After four failed attempts the pane reports an error and closes its broken PTY,
  retaining the displayed text and normal Retry action. Old-session callbacks and
  retries are cancelled on exit, respawn or disposal.
  If Retry is pressed while that PTY is still stopping, replacement creation waits
  for its exit event. A failed kill remains retriable instead of reusing the ID
  while the old reader can still run cleanup.
- Small PTY messages reuse Rust's byte count, avoiding an extra allocation and
  UTF-8 encoding pass. Activity notifications occur once per PTY message; the
  activity tracker updates a deadline instead of replacing a timer for every chunk.
- Unix output reads opportunistically drain bytes already available in the PTY
  into batches up to 8 KiB, checking a 250 µs drain budget between reads. A
  zero-timeout readiness poll never waits for future output; sparse prompts and
  TUI responses leave immediately. A duplicated descriptor protects the poll
  against descriptor reuse, without changing shared file flags. ConPTY retains
  its existing read behaviour. `pty_output.rs` tests byte order/tails, sparse
  input, the budget and fallback when readiness is unavailable.
- WebGL activation failures dispose partial addons. Context loss falls back to DOM,
  requests remeasurement and retries while visible. Closing panes explicitly releases
  GPU contexts rather than relying on garbage collection.
  Successful activation alone does not reset the two-retry allowance: the context
  must remain active for ten seconds before a later loss starts a fresh allowance.
  This prevents repeated activate/loss cycles from retrying forever. Disposed-addon
  events cannot tear down a replacement; loss during activation retains DOM fallback.

## Managed xterm patch

`patches/@xterm+xterm+6.0.0.patch` contains source, typings and rebuilt CJS/ESM:

1. Parser yield budget: 12 → 4 ms.
2. `enhancedWheel`, disabled by default in the library, bypasses the small-delta
   reduction in native mouse handling. Swarmterm enables it in Enhanced mode.
3. Smooth viewport updates flush pending row rendering in their existing animation
   frame instead of waiting for another frame.
4. When streaming output trims scrollback, the viewport rebases the active animation
   by the trimmed rows while retaining its original frame and end time. Previously,
   buffer synchronisation could cancel a wheel gesture before its first frame.

To change the patch, edit installed TypeScript source, then run:

```sh
npm run patch:xterm:build
npx patch-package @xterm/xterm
```

Do not edit minified bundles manually. Test a clean `npm ci` in an isolated copy;
`postinstall` must apply the patch and both entrypoints must remain usable. The
adapter in `terminal-xterm.ts` is intentionally tied to this pinned version.

## Native benchmark

```sh
npm run benchmark:terminal -- --report artifacts/terminal-benchmark-after.json
npm run benchmark:baseline -- --ref c3b730f --report artifacts/terminal-benchmark-baseline.json
node scripts/benchmark-compare.mjs \
  --baseline artifacts/terminal-benchmark-baseline.json \
  --after artifacts/terminal-benchmark-after.json \
  --report artifacts/terminal-benchmark-comparison.json
```

Stop an existing Vite server on port 1420 first. The driver starts its own forced
dependency build to avoid stale patched bundles or another checkout's dev server.
It rejects runs that contain a Vite reload/HMR event: do not edit files during
measurement, as a reload can mix code versions and leave extra fixture processes.
Keep the benchmark window visible. Each run opens an isolated debug-only Tauri
window: normal application setup, agent launch, hook installation and telemetry
are not run. A deterministic local subprocess supplies the real PTY workload.
The baseline helper archives the specified pre-change commit into a temporary
directory and adds only fixture/measurement instrumentation. It leaves the old
terminal input, parser, renderer and output scheduling intact.

The full matrix contains two modes × 1/4 panes × static log/stream/TUI/TUI+stream
× three repetitions, with 30 replayed wheel events per case. The baseline contains
24 cases. `--quick` runs four smoke cases, insufficient for acceptance. The runner
checks TUI report quantities, actual changed viewport/TUI content, render events,
rAF cadence, renderer status and pending output. Unit tests additionally cover
fractional input, delta modes, burst limits and protocol transitions.
Reports also contain IPC messages/MiB and per-event traces separating wheel
dispatch, parsed TUI response, frame phase and actual render latency.

Wheel-to-render measures actual xterm row rendering. The following rAF is labelled
**presentation opportunity**, not physical scanout. Synthetic replay does not
measure trackpad hardware latency, physical display refresh or subjective scrolling.
Streaming MiB/s is achieved fixture rate, not maximum parser throughput. The old
Node `scrollLines()` call timings cannot establish visual smoothness.

## Evidence and remaining gates (2026-10-31)

Reviewed JSON reports are in [`benchmarks/2026-10-31`](benchmarks/2026-10-31).
The pre-hardening 60 fps measurement is [`after-coalesced.json`](benchmarks/2026-10-31/after-coalesced.json),
compared against [`baseline-trace.json`](benchmarks/2026-10-31/baseline-trace.json).
The earlier `after.json`/`baseline.json` pair is retained as historical evidence
from before output coalescing, rather than overwritten.
Environment: Apple Silicon, Darwin 25.5.0, native WKWebView, visible focused window,
WebGL active in every measured pane. Values below are medians of three per-run p95s.

| Workload | Before | Enhanced after |
| --- | ---: | ---: |
| Static, 1 pane | 11 ms | 12 ms |
| Static, 4 panes | 10 ms | 10 ms |
| Stream, 4 panes | 11 ms | 10 ms |
| TUI + stream, 4 panes | 10 ms | 12 ms |
| Maximum pending output across cases | 757,756 B | 262,144 B |
| IPC data messages/MiB, stream, 1 pane | 1,126 | 240 |
| IPC data messages/MiB, stream, 4 panes | 1,126 | 280 |

The complete final 48-case run preserved expected TUI quantities and completed
without the lost viewport response reproduced before the scrollback-animation fix.
All observed chunks were at most 8 KiB and pending output stayed within 256 KiB.
Achieved streaming rate stayed within the 15% regression allowance.
Streaming cases used roughly 74–79% fewer IPC data messages/MiB than the pre-change
terminal, based on the medians for each workload/pane combination.

**The original stretch target remains unproven and is deferred.** The 2026-10-31
coalesced comparison deliberately returns exit status 2: its quiet scrollback p95
check passes, but no streaming case demonstrates a 25% p95 improvement against the
real baseline. TUI + stream at four panes remains slower in this run. The user
accepted the present approximately 60 fps experience for this phase; this decision
does not turn the earlier stretch-performance gate into a passing measurement.
Do not describe these results as proof of zero latency, universally faster rendering
or iTerm-equivalent smoothness. Keep the raw results and unchanged stretch gate
for the next phase.

rAF averaged roughly 16.4–16.8 ms, around 60 callbacks/s on this machine's 120 Hz
display. This observation does not establish a universal WebKit cap. WebKit
documents the distinction between accelerated animation and script-driven updates
in its [frame-rate explainer](https://webkit.github.io/explainers/animation-frame-rate/),
and tracks [high-refresh WKWebView support](https://bugs.webkit.org/show_bug.cgi?id=294338).
No high-refresh private macOS preference/API workaround is included in the current code.

## Deferred development: high refresh and remaining latency

The user explicitly deferred this work on 2026-10-31. It is a future feature,
not a remaining requirement of the current 60 fps delivery.

- **120 Hz / ProMotion:** investigate a supported WKWebView API as WebKit evolves.
  The upstream issue above tracks the missing public control for embedders.
- A short isolated research probe toggled the internal
  `PreferPageRenderingUpdatesNear60FPSEnabled` feature off through WebKit's feature
  catalog. On this machine, rAF p95 fell to about 9–10 ms, consistent with a higher
  callback cadence. This is a four-case exploratory result, not physical scanout
  verification or a release acceptance run. The probe code and its environment
  switch were removed following the user's decision; the research JSON is retained
  as [`high-refresh-research.json`](benchmarks/2026-10-31/high-refresh-research.json).
- If a future experimental option uses SPI, isolate it to the main terminal
  WebView, discover selectors/the exact catalog feature, verify writes, restore
  the original value when disabled, and retain a working unsupported fallback.
  Reassess WebKit/SDK compatibility and power use before shipping it. The relevant
  upstream implementation is [WKPreferences.mm](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKPreferences.mm).
- Repeat interleaved pre-change/after measurements, with uniform input phases and
  continuous trackpad replay, to separate scheduling noise, TUI round trips and
  animation. Revisit the 25% stressed-p95 target using the recorded traces.
- Complete physical mouse/trackpad, Vietnamese IME, clipboard/search/selection,
  and Windows/Linux smoke tests before a release-level sign-off.

## Runtime hardening and recheck (2026-11-01)

Follow-up work fixes stalled output after an ACK rejection, bounds repeated WebGL
activate/loss cycles, and keeps terminal Retry safe while the old PTY exits. Tests
exercise temporary/permanent ACK failures, synchronous IPC throws, a full 256 KiB
window, one in-flight ACK, stale callbacks, disposal, retry-before-exit and failed
kill recovery. Renderer tests cover immediate repeated losses, stable recovery,
stale-addon events and loss during activation. Runtime failures use the existing
error/Retry overlay, whose title now covers errors after startup as well.

The fixed-source native run completed all 48 cases with WebGL active, exact TUI
quantities within fractional tolerance, chunks at most 8 KiB and peak pending output
of 262,144 bytes. Mean rAF intervals were 16.37–16.77 ms, still approximately 60 fps.
Reports: [`after.json`](benchmarks/2026-11-01/after.json) and
[`comparison.json`](benchmarks/2026-11-01/comparison.json).

This recheck validates the normal runtime path, while failure recovery is verified
by injected-failure unit tests. It does **not** prove faster scrolling: against the
recorded pre-change baseline, median quiet-scroll p95 was 13 ms for one pane and
17 ms for four panes, exceeding the original 10% allowance. The 25% stressed-p95
target is also unmet. Retain this result alongside the earlier measurements; the
60 fps scope and deferred high-refresh work remain as confirmed by the user.

Validation: 96 frontend files / 1,261 tests and production build passed after the
runtime hardening. The earlier unchanged Rust backend passed 411 tests and the
release-mode Rust check. Clean patch installation passed. Both native CJS and
ESM imports load, and all 13 patched files match the clean installation byte for byte.
