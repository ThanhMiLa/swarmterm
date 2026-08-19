# Agent roster expansion — design

- **Date:** 2026-08-19
- **Status:** approved direction; implementation not started
- **Depends on:** Đ1 agent state detection (shipped 2026-08-15, `docs/superpowers/specs/2026-08-15-agent-state-detection-design.md`)
- **Source survey:** herdr v0.8.0 @ `/Volumes/Woware/Projects/research/herdr` (Apache-2.0)

## Goal

Grow the set of AI agent CLIs Swarmterm treats as first-class agents beyond
`claude-code` / `codex` / `opencode`. A first-class agent gets a composer
template, availability probing, a state dot, War Room execute/nudge delivery,
and (where feasible) session resume and automatic MCP enrollment.

Motivation: users are already running unsupported CLIs (Antigravity was
reported) inside plain Terminal panes, where the War Room deliberately refuses
execute-mode (`agentId === null` ⇒ "Not running a coding agent") and no MCP
enrollment exists. The fix is roster support, not loosening that gate.

## Current state (what must change per new agent)

Agent ids are plain strings; `src/lib/templates.ts` is the source of truth.
Places that currently hard-code the 3-agent list:

| Site | Role |
|---|---|
| `src/lib/templates.ts` | canonical list: id, name, command, executable, icon |
| `src-tauri/src/agents.rs` | (id, exe) pairs for the "Not installed" probe |
| `src/lib/resume-command.ts` | per-agent session-id regex + resume flag (switch) |
| `src/lib/agent-sessions.ts` | `SESSION_FILTER_TABS` tuple |
| `src/lib/agent-state/manifests/index.ts` | manifest registry |
| `src-tauri/src/mcp/tools/worktree.rs` | `AGENT_IDS` allow-list + tool description text |
| `src-tauri/src/sessions/mod.rs` | hard-wired store scanners |
| `src-tauri/src/mcp/config.rs` | MCP enrollment (claude + codex only) |

Already agent-agnostic (no change needed per agent): War Room delivery/paste,
notification prefs (fail-open on unknown ids; settings rows derive from
manifest presence), worktree naming, availability store, per-pane agent
switcher, Avatar/AgentIcon (icon-less templates fall back to a generic glyph).

Orphan icons already in `src/assets/agents/`: `amp.svg`, `copilot.svg`,
`qwen.svg`.

## What we port from herdr (and what we cannot)

Port (Apache-2.0 → GPL-3.0, same attribution pattern as Đ1: entry in
`THIRD-PARTY-NOTICES.md`, herdr manifest version recorded in each file
header for later re-syncs):

- **Detection manifests** — `src/detect/manifests/*.toml`, translated
  TOML → TS per the Đ1 recipe (Rust-regex → JS RegExp).
- **Resume argv table** — `src/agent_resume.rs` (`plan()`): the per-CLI
  resume flag and id-vs-path ref kind.
- **Binary names, config dirs, env overrides** — `src/detect/mod.rs`
  (`interactive_agent_executable`), `src/integration/env.rs`,
  `src/integration/registry.rs`.
- **Known quirks** — e.g. Copilot ignores a synthetic Enter after focus
  loss until it receives a focus-gained event (herdr
  `src/app/api/agents.rs`); relevant to War Room execute delivery.

Cannot port (herdr has nothing to take):

- **Session store scanning.** herdr receives session ids pushed by installed
  hooks; it never scans `~/.claude/projects`-style stores. Our `sessions/`
  scanners must be researched per CLI.
- **MCP enrollment.** herdr installs state-reporting hooks, not MCP config.
  Each CLI's MCP config format is our own research.
- **Launch flags** (model/permissions/sandbox). herdr leaves them to the
  caller. Decision below: new templates use the plain binary as the command.

## Capability ladder

Support ships per-agent in independent levels; an agent may stop at any level.

- **L0 Spawn** — composer template, per-pane switcher, availability probe,
  worktree allow-list, War Room execute/nudge delivery (pane has an agentId).
- **L1 State** — detection manifest → StateDot, notifications, navbar rollup.
  No manifest ⇒ the pane keeps the legacy ActivityDot; the agent simply does
  not appear in Settings → Notifications (rows derive from manifest presence).
- **L2 Resume** — appears in the composer "Resume sessions" list: id regex +
  resume command (from herdr's table) + a Rust store scanner (own research).
- **L3 MCP** — automatic enrollment so the agent can call `war_room.*` /
  `worktree.*` without the manual hint in MembersTab.

## Roster

| Template id | Display name | Binary | herdr manifest | Resume (herdr) | Icon | Wave |
|---|---|---|---|---|---|---|
| `copilot` | GitHub Copilot | `copilot` | 2026.07.07.1 (e1) | `copilot --resume=<id>` | exists | 1 |
| `qwen` | Qwen Code | `qwen` | 2026.08.14.1 (e2) | `qwen --resume <id>` | exists | 1 |
| `amp` | Amp | `amp` | 2026.07.09.1 (e2) | none (herdr has none) | exists | 1 |
| `gemini` | Gemini CLI | `gemini` | 2026.06.10.1 (e1) | none (herdr has none) | new | 2 |
| `cursor` | Cursor Agent | `cursor-agent` (win: `.cmd`) | 2026.08.03.1 (e1) | `cursor-agent --resume <id>` | new | 2 |
| `antigravity` | Antigravity | `agy` | 2026.06.24.1 (e1) | `agy --conversation <id>` | new | 2 |
| `omp` | OMP (Oh My Pi) | `omp` | **none — see below** | `omp --resume=<id-or-path>` | new | 2 |

On-demand pool (herdr has manifests + most have resume; add when a real user
asks): pi, droid, kimi, grok, kilo, kiro, devin, cline, hermes, qodercli,
maki, mastracode. Pi is the cheapest rider if OMP lands (see OMP note).

Decisions:

- **Template ids** are the short names above (they double as icon file names
  and notification-pref keys). They need not match herdr labels; the manifest
  registry is keyed by template id (existing convention: `claude-code` vs
  herdr's `claude`).
- **Commands are the plain binary** — no baked YOLO/permission flags.
  Precedent: `codex` / `opencode` ship plain; `claude` is the historical
  exception.
- The War Room `agentId === null` execute gate stays as is. Roster support is
  the fix for the Antigravity-class reports, not a gate bypass.

### OMP note (no herdr manifest, by design)

herdr classifies `omp` (and `mastracode`) as *full-lifecycle-hook
authorities*: screen detection is disabled and state comes only from an
installed hook. There is therefore no manifest to port.

Plan: ship OMP at **L0** in wave 2. Then attempt a hand-authored L1 manifest
adapted from herdr's `pi.toml` (OMP is a Pi derivative — herdr even reuses
`PI_CONFIG_DIR` for its config dir), verified against a real OMP session. If
OMP's TUI proves unscrapable (which may be why herdr went hooks-only), OMP
stays at L0 with the ActivityDot and the user guide documents the limit. We
do NOT build a hook/extension install path for one agent.

## Wave 0 — catalog refactor (prerequisite)

Stop the 3-agent list from being copy-pasted into a 10-agent list in eight
places. After this wave, one new agent at L0+L1 = one template entry + one
manifest file + one Rust line + one icon.

- Extend `WorkspaceTemplate` (or split an `agent-catalog.ts` beside it) with:
  - `resume?: { idPattern: RegExp; buildCommand(id: string): string }`
  - `sessionScanner?: 'claude-jsonl' | 'codex-rollout' | 'opencode-cli'`
    (a tag the Rust side mirrors; absence = no L2)
- Derive from the catalog instead of local switches/tuples:
  - `resume-command.ts` (`isValidSessionId`, `buildResumeCommand`)
  - `agent-sessions.ts` `SESSION_FILTER_TABS`
  - `NotificationsPanel` rows (already derives from manifest presence — keep)
- Rust: `worktree.rs::AGENT_IDS` sources from `agents.rs::AGENTS`; the
  existing parity test (`agents.rs` ↔ `templates.ts` order) stays the guard
  across the language boundary. Tool description strings mentioning agent ids
  are generated from the same const.
- TDD: existing `templates.test.ts`, `resume-command.test.ts`,
  `agent-sessions.test.ts` are updated first to read from the catalog; their
  assertions on the current 3 agents must not weaken.

## Wave 1 — Copilot, Qwen, Amp (L0 + L1)

- One template entry each (icons already in repo), one `agents.rs` line each.
- Port `github-copilot.toml`, `qwen.toml`, `amp.toml` manifests → TS with
  fixture tests per agent (same shape as `manifests.test.ts` today).
- Before porting, diff herdr's manifest schema/validator
  (`scripts/agent_detection_manifest_check.py`) against our engine: Qwen and
  Amp declare `min_engine_version = 2` — confirm no gate/region kind is
  missing from the Đ1 port; extend `regions.ts`/`engine.ts` if so.
- War Room execute smoke per agent; implement the Copilot focus-gained quirk
  only if the smoke actually reproduces the dropped Enter inside xterm.js.
- L2 for Copilot/Qwen ships separately, fail-open: resume flags + id regexes
  land with the wave (from herdr's table; verify real id shapes), but the
  "Resume sessions" list only includes them once their store scanners exist
  (research `~/.copilot`, `~/.qwen` formats first; if a store is unstable or
  undocumented, skip the scanner and revisit). Amp has no resume — herdr
  doesn't either.

## Wave 2 — Gemini, Cursor, Antigravity, OMP (L0 + L1)

- Same recipe as wave 1, plus four new icons (`gemini.svg`, `cursor.svg`,
  `antigravity.svg`, `omp.svg`) drawn in the existing mono-glyph style.
- Cursor: availability probe must resolve `cursor-agent.cmd` on Windows —
  verify `agents.rs` probe behavior for `.cmd` shims.
- Antigravity: manifest `antigravity.toml` is keyed `agy` in herdr — ours is
  keyed by template id `antigravity`.
- OMP: L0 only at first; L1 attempt per the OMP note above.
- Resume flags: cursor + antigravity + omp from herdr's table; gemini has
  none. Scanners again fail-open per CLI.

## Wave 3 — MCP enrollment (L3)

Only for agents users actually put in the War Room (start with wave-1 agents;
add others on demand). One writer per CLI in `mcp/config.rs`, following the
existing axis (documented there): does the CLI expand `${VAR}` in its config?

- Yes → Claude-style placeholder entry written once
  (`${SWARMTERM_MCP_URL}` / `${SWARMTERM_SESSION}`).
- No → Codex-style concrete URL merge-written on every boot.

Config paths and env overrides come from herdr's integration registry
(`COPILOT_HOME` → `~/.copilot`, `QWEN_HOME` → `~/.qwen`, etc.). Rules carried
over from the existing writers: merge, never clobber foreign keys; atomic
tmp+rename; skip when current. Per-CLI MCP support is a research question
(Antigravity and OMP may not speak MCP-over-HTTP at all); the MembersTab
manual hint remains the universal fallback.

## Risks / verify while implementing

1. **Engine version drift.** herdr manifests declare `min_engine_version`
   1–3 (Grok needs 3). Diff the schema before each port; the Đ1 engine was
   frozen at claude 2026.08.13.1 / codex 2026.08.09.1.
2. **`regions.ts` hard-codes Claude/Codex chrome** (Codex `›` prompt marker,
   Claude prompt-box/horizontal-rule). New manifests may require new region
   kinds — engine change, not just data.
3. **Session stores are undocumented.** Copilot/Qwen/others may change format
   without notice; scanners stay fail-open (error ⇒ empty list) like the
   existing three.
4. **Composer height.** 7+ stepper rows in the 2-column dialog — check
   overflow; add scroll/compaction if it clips at the common window size.
5. **Manifests are snapshots.** herdr fixes rules continuously (qwen fixed
   2026-08-14, the day after it landed). Keep the version-header + periodic
   re-sync pattern from Đ1.
6. **Windows binary resolution** for `.cmd` shims (Cursor) in the
   availability probe and in the spawned shell line.

## Non-goals

- Statusline for non-Claude agents (design is bound to Claude Code's stdin
  schema).
- herdr-style hook/plugin installation for state reporting (screen-scrape +
  MCP is our model; OMP does not get a special hook path either).
- All 22 herdr agents in one sweep — every agent added is a surface that
  needs a real smoke test.
- Relaxing the War Room shell-member execute gate.

## Testing

- Per-wave: `npm test` + `npx tsc --noEmit`; `cargo test` for `agents.rs` /
  `worktree.rs` / new scanners; manifest fixture tests per agent from real
  captured screens.
- Manual smoke per agent (requires the CLI installed): spawn from composer,
  state dot transitions, War Room execute round-trip, resume (where L2),
  MCP tool call (where L3). Add a row per agent to
  `docs/manual-smoke-tests.md` when the wave ships.
- User-facing docs: user guide's agent list + War Room section update per
  wave (README stays high-level).
