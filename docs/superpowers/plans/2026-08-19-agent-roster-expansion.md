# Agent Roster Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow the first-class agent roster from 3 CLIs (claude-code / codex / opencode) to 10, by first refactoring the hard-coded 3-agent lists into a single catalog, then adding Copilot/Qwen/Amp (wave 1) and Gemini/Cursor/Antigravity/OMP (wave 2) at L0+L1, a Qwen session scanner (L2) and Qwen MCP enrollment (L3).

**Architecture:** `src/lib/templates.ts` becomes the one catalog (id, name, command, executable, icon, resume rule, session-scanner tag); `resume-command.ts` and `agent-sessions.ts` derive from it instead of local switches/tuples. On the Rust side `agents.rs::AGENTS` becomes the mirror catalog that `worktree.rs` derives its allow-list from. Detection manifests are TOML→TS ports from herdr (Apache-2.0) into `src/lib/agent-state/manifests/`, evaluated by the existing Đ1 engine (no engine changes needed — verified: the v3 gate is `top_non_empty_lines`, already ported).

**Tech Stack:** React 19 + TypeScript (strict) + Vitest; Rust (Tauri 2) + cargo test. Source survey: herdr v0.8.0 @ `/Volumes/Woware/Projects/research/herdr` (Apache-2.0).

**Spec:** `docs/superpowers/specs/2026-08-19-agent-roster-expansion-design.md`

## Global Constraints

- Template ids are the notification-pref keys and icon file names: `copilot`, `qwen`, `amp`, `gemini`, `cursor`, `antigravity`, `omp`.
- New agent commands are the **plain binary** (no permission flags); `claude --dangerously-skip-permissions` stays the historical exception.
- The War Room `agentId === null` execute gate is untouched.
- Every ported manifest file carries the herdr attribution header + herdr manifest version (same pattern as `manifests/codex.ts`).
- Regex translation recipe (from `codex.ts` header): Rust `\x{2733}` → JS `\u{2733}` with `u` flag; inline `(?i)` → `i` flag; NEVER add `g` (stateful `.test`).
- `AGENTS` order in `agents.rs` must equal `TEMPLATES` order in `templates.ts` (minus `terminal`); both order tests update together, per wave.
- Existing assertions on the current 3 agents must not weaken.
- TS is strict (`noUnusedLocals` etc.) — dead code fails the build.
- Before each commit touching `src-tauri/`: `cargo fmt` (CI has a fmt check).
- Scanners and MCP writers are fail-open: error ⇒ empty list / logged skip, never a blocking error.
- Only commit roster files — the working tree carries two unrelated uncommitted fixes (pty.rs LANG fallback; App.tsx/terminal-registry.ts refit). Never `git add -A`.

---

## Wave 0 — catalog refactor

### Task 1: Catalog fields + derived resume commands

**Files:**
- Modify: `src/lib/templates.ts`
- Modify: `src/lib/resume-command.ts`
- Test: `src/lib/templates.test.ts`, `src/lib/resume-command.test.ts`

**Interfaces:**
- Produces: `WorkspaceTemplate.resume?: { idPattern: RegExp; buildCommand(base: string, sessionId: string): string }`, `WorkspaceTemplate.sessionScanner?: SessionScannerKind`, `type SessionScannerKind = 'claude-jsonl' | 'codex-rollout' | 'opencode-cli' | 'qwen-chats'`. `isValidSessionId` / `buildResumeCommand` keep their exact signatures.

- [ ] **Step 1: Extend templates.test.ts (failing first)** — add to the existing describes:

```ts
describe('resume catalog', () => {
  it('gives the three launch agents a resume rule and scanner tag', () => {
    for (const id of ['claude-code', 'codex', 'opencode']) {
      const t = templateById(id)
      expect(t.resume).toBeDefined()
      expect(t.sessionScanner).toBeDefined()
    }
    expect(templateById('terminal').resume).toBeUndefined()
    expect(templateById('terminal').sessionScanner).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run** `npm test -- templates` — expect FAIL (`resume` undefined).

- [ ] **Step 3: Implement in templates.ts** — add above `TEMPLATES`:

```ts
/** Session ids come from on-disk stores owned by other programs and are typed
 *  into a live shell line — each pattern is an allow-list, not a sanity check. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// OpenCode: "ses_" + 12 hex + 14 base62 today; ranged so a minor format bump
// doesn't silently kill the feature, while still shell-safe ([A-Za-z0-9] only).
const OPENCODE_RE = /^ses_[A-Za-z0-9]{10,40}$/

export type SessionScannerKind = 'claude-jsonl' | 'codex-rollout' | 'opencode-cli' | 'qwen-chats'

export interface TemplateResume {
  /** Exact id shape this CLI emits. */
  idPattern: RegExp
  /** One-line resume command, built on the template's base command so flag
   *  changes (e.g. the claude permissions flag) carry over automatically. */
  buildCommand: (base: string, sessionId: string) => string
}

export interface WorkspaceTemplate {
  // ...existing fields...
  /** Resume support (L2): absent ⇒ the CLI cannot resume by id. */
  resume?: TemplateResume
  /** Backend store scanner feeding "Resume sessions"; absent ⇒ the agent
   *  has no scanner yet and never appears in that list. */
  sessionScanner?: SessionScannerKind
}
```

and per entry: claude-code `resume: { idPattern: UUID_RE, buildCommand: (base, id) => `${base} --resume ${id}` }, sessionScanner: 'claude-jsonl'`; codex `` (base, id) => `${base} resume ${id}` `` + `'codex-rollout'`; opencode `OPENCODE_RE`, `` (base, id) => `${base} --session ${id}` `` + `'opencode-cli'`.

- [ ] **Step 4: Rewrite resume-command.ts to derive from the catalog** (keep the untrusted-input header comment; the switches die):

```ts
import { agentCommand, templateById } from '@/lib/templates'

export function isValidSessionId(agentId: string, sessionId: string): boolean {
  const t = templateById(agentId)
  // templateById falls back to the default template for unknown ids.
  if (t.id !== agentId || t.resume === undefined) return false
  return t.resume.idPattern.test(sessionId)
}

export function buildResumeCommand(agentId: string, sessionId: string): string | undefined {
  if (!isValidSessionId(agentId, sessionId)) return undefined
  const base = agentCommand(agentId)
  if (base === undefined) return undefined
  return templateById(agentId).resume?.buildCommand(base, sessionId)
}
```

- [ ] **Step 5: Run** `npm test -- templates resume-command` — expect PASS (resume-command.test.ts unchanged: behavior identical).
- [ ] **Step 6: Run** `npx tsc --noEmit` — expect clean.
- [ ] **Step 7: Commit** `git add src/lib/templates.ts src/lib/templates.test.ts src/lib/resume-command.ts && git commit -m "refactor(catalog): move resume rules into the template catalog"`

### Task 2: Derive SESSION_FILTER_TABS

**Files:**
- Modify: `src/lib/agent-sessions.ts`
- Test: `src/lib/agent-sessions.test.ts`

**Interfaces:**
- Consumes: `TEMPLATES[i].sessionScanner` from Task 1.
- Produces: `SESSION_FILTER_TABS: readonly string[]` (value today unchanged: `['all','claude-code','codex','opencode']`).

- [ ] **Step 1: Add failing assertion** to agent-sessions.test.ts:

```ts
it('derives filter tabs from the catalog scanner tags', () => {
  expect(SESSION_FILTER_TABS).toEqual([
    'all',
    ...TEMPLATES.filter((t) => t.sessionScanner !== undefined).map((t) => t.id)
  ])
})
```

(import `TEMPLATES` from `@/lib/templates`; keep every existing tab assertion.)

- [ ] **Step 2: Implement**:

```ts
/** Tab order is fixed and always fully rendered; zero-count tabs disable
 *  in the UI rather than disappear. Derived from the catalog: an agent gets
 *  a tab exactly when a backend store scanner exists for it. */
export const SESSION_FILTER_TABS: readonly string[] = [
  'all',
  ...TEMPLATES.filter((t) => t.sessionScanner !== undefined).map((t) => t.id)
]
```

- [ ] **Step 3: Run** `npm test -- agent-sessions` then `npx tsc --noEmit` — expect PASS/clean (Welcome.tsx consumes it as strings already).
- [ ] **Step 4: Commit** `git commit -m "refactor(catalog): derive session filter tabs from scanner tags"` (add the two files).

### Task 3: Rust — publish AGENTS, derive the worktree allow-list

**Files:**
- Modify: `src-tauri/src/agents.rs` (make `AGENTS` pub)
- Modify: `src-tauri/src/mcp/tools/worktree.rs`

**Interfaces:**
- Produces: `pub const AGENTS: &[(&str, &str)]` in `agents.rs`; `worktree.rs::validate_agent_id` derives from it.

- [ ] **Step 1: Update the worktree test (failing first)** — replace `agent_id_allow_list`:

```rust
#[test]
fn agent_id_allow_list_tracks_agents_catalog() {
    assert!(validate_agent_id(None).is_ok());
    for (id, _) in crate::agents::AGENTS {
        assert!(validate_agent_id(Some(id)).is_ok());
    }
    assert!(validate_agent_id(Some("terminal")).is_err());
    assert!(validate_agent_id(Some("nope")).is_err());
}
```

- [ ] **Step 2: Run** `cargo test -p swarmterm agent_id` (from `src-tauri/`) — expect compile FAIL (`AGENTS` private).
- [ ] **Step 3: Implement** — in `agents.rs` change `const AGENTS` to `pub const AGENTS`; in `worktree.rs` delete the local `AGENT_IDS` and derive:

```rust
pub fn validate_agent_id(agent: Option<&str>) -> Result<(), String> {
    match agent {
        None => Ok(()),
        Some(a) if crate::agents::AGENTS.iter().any(|(id, _)| *id == a) => Ok(()),
        Some(a) => Err(format!(
            "unknown agent \"{a}\" — pass one of: {} (or omit to reuse the calling pane's agent)",
            crate::agents::AGENTS
                .iter()
                .map(|(id, _)| *id)
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}
```

Also make `WorktreeSpawnArgs.agent`'s doc comment roster-free: `/// Agent template id as shown in the workspace composer (e.g. "claude-code"). Omit to reuse the calling pane's agent.` (The runtime error enumerates the live list — that is the "generated from the same const" requirement; the schemars doc string cannot interpolate a const.)

- [ ] **Step 4: Run** `cargo fmt && cargo test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "refactor(catalog): worktree agent allow-list derives from agents.rs"`.

---

## Wave 1 — Copilot, Qwen, Amp (L0)

### Task 4: Wave-1 templates + probes

**Files:**
- Modify: `src/lib/templates.ts`, `src-tauri/src/agents.rs`
- Test: `src/lib/templates.test.ts`, `agents.rs` order test

**Interfaces:**
- Produces: template ids `copilot`, `qwen`, `amp` (order: after `opencode`, before `terminal`).

- [ ] **Step 1: Update both order tests (failing first)** — templates.test.ts ids array → `['claude-code','codex','opencode','copilot','qwen','amp','terminal']`; agents.rs `list_agents_covers_all_ai_agents_in_template_order` → `vec!["claude-code","codex","opencode","copilot","qwen","amp"]`. Also add resume expectations:

```ts
it('wave-1 resume commands follow the herdr table', () => {
  const id = 'fe845bc6-6932-4459-8fb6-cdd0e7c6cc84'
  expect(buildResumeCommand('copilot', id)).toBe(`copilot --resume=${id}`)
  expect(buildResumeCommand('qwen', id)).toBe(`qwen --resume ${id}`)
  expect(buildResumeCommand('amp', id)).toBeUndefined()
})
```

(imports from `@/lib/resume-command` in templates.test.ts or extend resume-command.test.ts — put it in resume-command.test.ts.)

- [ ] **Step 2: Run** `npm test -- templates resume-command` and `cargo test list_agents` — expect FAIL.
- [ ] **Step 3: Implement templates.ts** (icons already in repo):

```ts
import ampIcon from '@/assets/agents/amp.svg'
import copilotIcon from '@/assets/agents/copilot.svg'
import qwenIcon from '@/assets/agents/qwen.svg'
```

```ts
{
  id: 'copilot',
  name: 'GitHub Copilot',
  description: "GitHub's Copilot CLI.",
  command: 'copilot',
  executable: 'copilot',
  icon: copilotIcon,
  // Resume flag from herdr's table (--resume=<id>, equals form); ids are
  // UUIDs. No store scanner yet, so the composer list never offers these —
  // the rule is dormant until a scanner lands.
  resume: { idPattern: UUID_RE, buildCommand: (base, id) => `${base} --resume=${id}` }
},
{
  id: 'qwen',
  name: 'Qwen Code',
  description: "Alibaba's Qwen Code CLI.",
  command: 'qwen',
  executable: 'qwen',
  icon: qwenIcon,
  resume: { idPattern: UUID_RE, buildCommand: (base, id) => `${base} --resume ${id}` }
},
{
  id: 'amp',
  name: 'Amp',
  description: "Sourcegraph's Amp coding agent.",
  command: 'amp',
  executable: 'amp',
  icon: ampIcon
  // No resume: the CLI has no resume-by-id flag (herdr has none either).
},
```

and agents.rs:

```rust
const AGENTS: &[(&str, &str)] = &[
    ("claude-code", "claude"),
    ("codex", "codex"),
    ("opencode", "opencode"),
    ("copilot", "copilot"),
    ("qwen", "qwen"),
    ("amp", "amp"),
];
```

(keep `pub` from Task 3.)

- [ ] **Step 4: Run** `npm test`, `npx tsc --noEmit`, `cargo fmt && cargo test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(roster): add GitHub Copilot, Qwen Code and Amp templates (L0)"`.

## Wave 1 — detection manifests (L1)

Shared recipe for Tasks 5–7 and 10–12: one file per agent in `src/lib/agent-state/manifests/`, header comment naming the herdr source TOML + version + Apache-2.0 notice (copy the `codex.ts` header shape), register in `manifests/index.ts`, extend `manifests.test.ts` with a describe per agent. The engine is untouched.

### Task 5: Copilot manifest

**Files:**
- Create: `src/lib/agent-state/manifests/copilot.ts`
- Modify: `src/lib/agent-state/manifests/index.ts`
- Test: `src/lib/agent-state/manifests/manifests.test.ts`

- [ ] **Step 1: Fixture tests (failing first):**

```ts
describe('copilot manifest', () => {
  it('a selection dialog (esc-cancel + enter-select) is blocked', () => {
    const v = evaluateManifest(copilotManifest, input('Pick a model\nesc to cancel · enter to select'))
    expect(v.state).toBe('blocked')
    expect(v.visibleBlocker).toBe(true)
  })
  it('an esc-cancel hint alone means working', () => {
    const v = evaluateManifest(copilotManifest, input('Thinking… esc to cancel'))
    expect(v.state).toBe('working')
    expect(v.visibleWorking).toBe(true)
  })
  it('the blocker outranks the working hint on the same screen', () => {
    expect(evaluateManifest(copilotManifest, input('esc to cancel\nenter to confirm')).state).toBe('blocked')
  })
  it('a quiet screen falls back to idle', () => {
    expect(evaluateManifest(copilotManifest, input('$ done')).state).toBe('idle')
  })
})
```

- [ ] **Step 2: Run** `npm test -- manifests` — FAIL (module missing).
- [ ] **Step 3: Implement copilot.ts** (port of `github-copilot.toml` 2026.07.07.1):

```ts
export const copilotManifest: Manifest = {
  id: 'copilot',
  herdrVersion: '2026.07.07.1',
  rules: [
    {
      id: 'selection_blocker',
      state: 'blocked',
      priority: 300,
      region: 'whole_recent',
      visibleBlocker: true,
      all: [
        { any: [{ contains: ['esc to cancel'] }, { contains: ['esc cancel'] }] },
        {
          any: [
            { contains: ['enter to select'] },
            { contains: ['enter to confirm'] },
            { contains: ['enter to submit'] },
            { contains: ['enter accept'] }
          ]
        }
      ]
    },
    {
      id: 'working_cancel_hint',
      state: 'working',
      priority: 100,
      region: 'whole_recent',
      visibleWorking: true,
      any: [
        { contains: ['esc to cancel'] },
        { contains: ['esc cancel'] },
        { contains: ['esc again to cancel'] },
        { contains: ['esc interrupt'] }
      ]
    }
  ]
}
```

Register in index.ts (`copilot: copilotManifest`).

- [ ] **Step 4: Run** `npm test -- manifests` + `npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(roster): port copilot detection manifest from herdr (L1)"`.

### Task 6: Qwen manifest

Same files as Task 5 pattern (`qwen.ts`).

- [ ] **Step 1: Fixture tests (failing first):**

```ts
describe('qwen manifest', () => {
  it('✳-prefixed OSC title means blocked, ◐ means working', () => {
    expect(evaluateManifest(qwenManifest, input('x', '✳ Waiting for approval')).state).toBe('blocked')
    expect(evaluateManifest(qwenManifest, input('x', '◐ Generating…')).state).toBe('working')
  })
  it('waiting-for-confirmation footer is blocked (any locale needle)', () => {
    const screen = '⠏ esbuild src/main.ts...\nWaiting for user confirmation...'
    expect(evaluateManifest(qwenManifest, input(screen)).state).toBe('blocked')
  })
  it('a tool confirmation dialog is blocked', () => {
    const screen = 'Apply this change?\n● Yes, allow once'
    expect(evaluateManifest(qwenManifest, input(screen)).state).toBe('blocked')
  })
  it('a numbered question dialog is blocked', () => {
    expect(evaluateManifest(qwenManifest, input('❯ 1. Yes, proceed')).state).toBe('blocked')
  })
  it('the folder trust dialog is blocked', () => {
    const screen = "Do you trust this folder?\nTrust folder (enter)\nDon't trust (esc)"
    expect(evaluateManifest(qwenManifest, input(screen)).state).toBe('blocked')
  })
  it('the timed esc-to-cancel status line means working (wide and narrow)', () => {
    expect(evaluateManifest(qwenManifest, input('⠹ Thinking (12s · esc to cancel)')).state).toBe('working')
    expect(evaluateManifest(qwenManifest, input('(2m 5s · esc to cancel)')).state).toBe('working')
  })
  it('OSC 9;4 tool progress means working', () => {
    expect(evaluateManifest(qwenManifest, input('x', '', '4;3;50')).state).toBe('working')
  })
  it('the composer placeholder is proven idle', () => {
    const v = evaluateManifest(qwenManifest, input('> Type your message or @path/to/file'))
    expect(v.state).toBe('idle')
    expect(v.visibleIdle).toBe(true)
  })
})
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement qwen.ts** (port of `qwen.toml` 2026.08.14.1; keep herdr's rationale comment about status-prefixed titles):

```ts
export const qwenManifest: Manifest = {
  id: 'qwen',
  herdrVersion: '2026.08.14.1',
  rules: [
    { id: 'osc_title_blocked', state: 'blocked', priority: 1200, region: 'osc_title', visibleBlocker: true, regex: [/^\u{2733}\u{FE0E}? /u] },
    { id: 'osc_title_working', state: 'working', priority: 1100, region: 'osc_title', visibleWorking: true, regex: [/^\u{25D0}\u{FE0E}? /u] },
    {
      id: 'waiting_for_confirmation', state: 'blocked', priority: 1000,
      region: { bottomNonEmptyLines: 20 }, visibleBlocker: true,
      lineRegex: [/^\s*⠏\s+.*\.\.\.\s*$/],
      any: [
        { contains: ['Waiting for user confirmation...'] },
        { contains: ['等待用户确认...'] },
        { contains: ['等待用戶確認...'] },
        { contains: ['Warten auf Benutzerbestätigung...'] },
        { contains: ["En attente de la confirmation de l'utilisateur..."] },
        { contains: ['ユーザーの確認を待っています...'] },
        { contains: ['Aguardando confirmação do usuário...'] },
        { contains: ['Ожидание подтверждения от пользователя...'] },
        { contains: ["Esperant la confirmació de l'usuari..."] }
      ]
    },
    {
      id: 'tool_confirmation', state: 'blocked', priority: 990,
      region: { bottomNonEmptyLines: 20 }, visibleBlocker: true,
      contains: ['yes, allow once'],
      any: [
        { contains: ['apply this change?'] },
        { contains: ['allow execution of:'] },
        { contains: ['allow execution of mcp tool'] },
        { contains: ['do you want to proceed?'] },
        { contains: ['shell command execution'] }
      ]
    },
    {
      id: 'question_dialog', state: 'blocked', priority: 980,
      region: { bottomNonEmptyLines: 20 }, visibleBlocker: true,
      lineRegex: [/^\s*[❯›]\s*(?:\[(?: |✓)\]\s*)?\d+\.\s+/, /^\s*↑\/↓\s*:.*(?:Enter|Return)\s*:/]
    },
    {
      id: 'folder_trust_dialog', state: 'blocked', priority: 970,
      region: { bottomNonEmptyLines: 20 }, visibleBlocker: true,
      contains: ['do you trust this folder?', 'trust folder (', "don't trust (esc)"]
    },
    {
      id: 'cancel_hint_working', state: 'working', priority: 900,
      region: { bottomNonEmptyLines: 8 }, visibleWorking: true,
      lineRegex: [/^\s*(?:[⠁-⣿]|\.{1,2})\s+.*\(\d+(?:m(?:\s+\d+s)?|s).*\s·\sesc to cancel\)\s*$/]
    },
    {
      id: 'narrow_cancel_hint_working', state: 'working', priority: 890,
      region: { bottomNonEmptyLines: 8 }, visibleWorking: true,
      lineRegex: [/^\s*\(\d+(?:m(?:\s+\d+s)?|s)\s·\sesc to cancel\)\s*$/]
    },
    { id: 'osc_tool_progress_working', state: 'working', priority: 850, region: 'osc_progress', visibleWorking: true, regex: [/^4;3(?:;|$)/] },
    {
      id: 'composer_idle', state: 'idle', priority: 100,
      region: { bottomNonEmptyLines: 30 }, visibleIdle: true,
      lineRegex: [/^\s*>\s*(?:type\s*)?.*$/],
      any: [
        { contains: ['type your message'] },
        { contains: ['your message or @path/to/file'] },
        { contains: ['@path/to/file'] },
        { contains: ['type', 'mes', 'sage', '@pat', 'h/to', '/fil'] }
      ]
    }
  ]
}
```

- [ ] **Step 4: Run + register + tsc** — PASS. **Step 5: Commit** `git commit -m "feat(roster): port qwen detection manifest from herdr (L1)"`.

### Task 7: Amp manifest

Same file pattern (`amp.ts`).

- [ ] **Step 1: Fixture tests (failing first):**

```ts
describe('amp manifest', () => {
  it('the plugin-confirmation OSC title is blocked', () => {
    expect(evaluateManifest(ampManifest, input('x', 'Plugin confirmation needed')).state).toBe('blocked')
  })
  it('a braille-spinner OSC title means working and beats the idle title', () => {
    expect(evaluateManifest(ampManifest, input('x', '⣟ compiling - amp - repo')).state).toBe('working')
  })
  it('the approval footer is blocked (plain and nested approve forms)', () => {
    expect(evaluateManifest(ampManifest, input('Waiting for approval')).state).toBe('blocked')
    const nested = 'Approve this tool call?\nAllow all for this session'
    expect(evaluateManifest(ampManifest, input(nested)).state).toBe('blocked')
  })
  it('the ╰ status footer means working', () => {
    expect(evaluateManifest(ampManifest, input('output\n╰ gpt-5 thinking ─────')).state).toBe('working')
  })
  it('a " - amp - " title with no spinner is proven idle', () => {
    const v = evaluateManifest(ampManifest, input('x', 'repo - amp - ready'))
    expect(v.state).toBe('idle')
    expect(v.visibleIdle).toBe(true)
  })
})
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement amp.ts** (port of `amp.toml` 2026.07.09.1):

```ts
const AMP_BRAILLE_TITLE = /^[\u{2800}-\u{28FF}] /u

export const ampManifest: Manifest = {
  id: 'amp',
  herdrVersion: '2026.07.09.1',
  rules: [
    { id: 'osc_title_plugin_confirmation_blocked', state: 'blocked', priority: 1100, region: 'osc_title', visibleBlocker: true, contains: ['Plugin confirmation needed'] },
    { id: 'osc_title_working', state: 'working', priority: 1050, region: 'osc_title', visibleWorking: true, regex: [AMP_BRAILLE_TITLE] },
    {
      id: 'approval_footer', state: 'blocked', priority: 300,
      region: 'whole_recent', visibleBlocker: true,
      any: [
        { contains: ['waiting for approval'] },
        { contains: ['invoke tool'] },
        { contains: ['run this command?'] },
        { contains: ['allow editing file:'] },
        { contains: ['allow creating file:'] },
        { contains: ['confirm tool call'] },
        {
          contains: ['approve'],
          any: [
            { contains: ['allow all for this session'] },
            { contains: ['allow all for every session'] },
            { contains: ['allow file for every session'] },
            { contains: ['deny with feedback'] }
          ]
        }
      ]
    },
    {
      id: 'status_footer_working', state: 'working', priority: 200,
      region: { bottomNonEmptyLines: 5 }, visibleWorking: true,
      lineRegex: [/^\s*╰\s+\S+\s+(thinking|streaming|running tools|waiting)\s+─/i]
    },
    { id: 'esc_cancel_working', state: 'working', priority: 100, region: 'whole_recent', visibleWorking: true, contains: ['esc to cancel'] },
    {
      id: 'osc_title_idle', state: 'idle', priority: 50,
      region: 'osc_title', visibleIdle: true,
      contains: [' - amp - '],
      not: [{ regex: [AMP_BRAILLE_TITLE] }, { contains: ['Plugin confirmation needed'] }]
    }
  ]
}
```

- [ ] **Step 4: Run + register + tsc** — PASS. **Step 5: Commit** `git commit -m "feat(roster): port amp detection manifest from herdr (L1)"`.

### Task 8: Qwen session scanner (L2)

**Files:**
- Create: `src-tauri/src/sessions/qwen.rs`
- Modify: `src-tauri/src/sessions/mod.rs`, `src/lib/templates.ts` (add `sessionScanner: 'qwen-chats'` to qwen), `src/lib/agent-sessions.test.ts` (tabs now include qwen)

**Interfaces:**
- Produces: `qwen::scan(projects_root: &Path, folder: &str) -> Vec<SessionEntry>` with `agent_id: "qwen"` (same shape as `claude::scan`; the fn itself appends `<encoded-cwd>/chats/`).

Store layout (verified against the installed qwen 0.21.12 bundle + `~/.qwen` on disk):
`$QWEN_HOME || ~/.qwen` → `projects/<encoded-cwd>/chats/`, where `<encoded-cwd>` uses the same every-non-alphanumeric→`-` encoding as Claude. Per session: `<uuid>.jsonl` (chat transcript), `<uuid>.runtime.json` (live-status sidecar), `<uuid>.worktree.json`.

- [ ] **Step 1: Pin the JSONL record shape empirically.** Run a throwaway qwen session in the scratchpad (`cd <scratchpad> && qwen`, one short prompt, quit — or drive it via `script -q`), then read `~/.qwen/projects/<slug>/chats/<uuid>.jsonl` and record the field names for a user message. **Fallback:** if no transcript can be produced (auth/network), extract the record writer from `~/.local/lib/qwen-code/lib/chunks/*.js`; if the shape still cannot be confirmed, STOP this task, leave qwen without `sessionScanner` (list simply never shows qwen), and note it in the final report.
- [ ] **Step 2: Write failing cargo tests** in `qwen.rs` mirroring `claude.rs` tests (session listed with title from first user message; noise skipped; missing dir ⇒ empty; non-UUID filename skipped; a session with only `.runtime.json` and no `.jsonl` contributes nothing), using the verified record shape in fixtures.
- [ ] **Step 3: Implement `qwen.rs`** modeled on `claude.rs` (reuse `read_head` / `mtime_ms` / `clean_title` / claude's `encode_project_dir` — re-export or move it to `mod.rs` if needed), plus `qwen_chats_root()` in `mod.rs` (`$QWEN_HOME` else `~/.qwen`, then `projects/`), and extend `list_all` with `qwen::scan` under the same spawn_blocking.
- [ ] **Step 4:** Add `sessionScanner: 'qwen-chats'` to the qwen template; update the tabs test expectation to `['all','claude-code','codex','opencode','qwen']`.
- [ ] **Step 5: Run** `npm test`, `npx tsc --noEmit`, `cargo fmt && cargo test` — PASS.
- [ ] **Step 6: Commit** `git commit -m "feat(roster): qwen session scanner + resume list tab (L2)"`.

---

## Wave 2 — Gemini, Cursor, Antigravity, OMP (L0)

### Task 9: Four icons + wave-2 templates + probes

**Files:**
- Create: `src/assets/agents/gemini.svg`, `cursor.svg`, `antigravity.svg`, `omp.svg`
- Modify: `src/lib/templates.ts`, `src-tauri/src/agents.rs`
- Test: order tests both sides, resume-command.test.ts

- [ ] **Step 1: Update order tests (failing first)** — TS ids: `['claude-code','codex','opencode','copilot','qwen','amp','gemini','cursor','antigravity','omp','terminal']`; Rust: same minus terminal. Resume assertions:

```ts
it('wave-2 resume commands follow the herdr table', () => {
  const id = 'fe845bc6-6932-4459-8fb6-cdd0e7c6cc84'
  expect(buildResumeCommand('cursor', id)).toBe(`cursor-agent --resume ${id}`)
  expect(buildResumeCommand('antigravity', id)).toBe(`agy --conversation ${id}`)
  expect(buildResumeCommand('omp', 'ses.abc-123')).toBe('omp --resume=ses.abc-123')
  expect(buildResumeCommand('omp', 'a b; rm -rf /')).toBeUndefined()
  expect(buildResumeCommand('gemini', id)).toBeUndefined()
})
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Write the icons** (single-path, brand-color or white fill like the existing set):

`gemini.svg` (the Gemini sparkle):
```svg
<svg fill="#3186FF" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Gemini CLI</title><path d="M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12 14.305 14.305 0 0 0-12 12"/></svg>
```

`cursor.svg` (cube mark):
```svg
<svg fill="#ffffff" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Cursor</title><path d="M12 1 2.5 6.5v11L12 23l9.5-5.5v-11L12 1Zm0 2.3 7.5 4.34L12 12 4.5 7.64 12 3.3ZM4.5 9.37 11 13.14v7.53L4.5 16.9V9.37Zm15 0v7.53L13 20.67v-7.53l6.5-3.77Z"/></svg>
```

`antigravity.svg` (lift-off arrow):
```svg
<svg fill="#ffffff" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Antigravity</title><path d="M12 2 4 13h5v5h6v-5h5L12 2Zm-6 17h12v3H6v-3Z"/></svg>
```

`omp.svg` (π glyph):
```svg
<svg fill="#ffffff" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>OMP</title><path d="M4 5v3h2.2v8.2c0 1.2-.3 2-1.6 2.3l.5 2.5c3-.3 4.3-2 4.3-4.7V8h4.9v8.9c0 2.6 1.4 4.1 3.7 4.1.9 0 1.6-.2 2-.4l-.6-2.7c-.2.1-.5.2-.8.2-.7 0-1.1-.4-1.1-1.5V8H20V5H4Z"/></svg>
```

- [ ] **Step 4: Template entries** (after `amp`, before `terminal`):

```ts
// OMP ids are unverified (no store scanner yet); conservative shell-safe
// allow-list, leading char alphanumeric so the value can never read as a flag.
const OMP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$/
```

```ts
{
  id: 'gemini',
  name: 'Gemini CLI',
  description: "Google's Gemini CLI.",
  command: 'gemini',
  executable: 'gemini',
  icon: geminiIcon
  // No resume: gemini has no resume-by-id flag (herdr has none either).
},
{
  id: 'cursor',
  name: 'Cursor Agent',
  description: "Cursor's CLI agent.",
  // The bare name also resolves cursor-agent.cmd on Windows via PATHEXT,
  // both in the probe (agents.rs candidates) and in the spawned shell line.
  command: 'cursor-agent',
  executable: 'cursor-agent',
  icon: cursorIcon,
  resume: { idPattern: UUID_RE, buildCommand: (base, id) => `${base} --resume ${id}` }
},
{
  id: 'antigravity',
  name: 'Antigravity',
  description: "Google's Antigravity agent CLI.",
  command: 'agy',
  executable: 'agy',
  icon: antigravityIcon,
  resume: { idPattern: UUID_RE, buildCommand: (base, id) => `${base} --conversation ${id}` }
},
{
  id: 'omp',
  name: 'OMP (Oh My Pi)',
  description: 'Community fork of the Pi coding agent.',
  command: 'omp',
  executable: 'omp',
  icon: ompIcon,
  resume: { idPattern: OMP_ID_RE, buildCommand: (base, id) => `${base} --resume=${id}` }
},
```

agents.rs additions (order): `("gemini", "gemini"), ("cursor", "cursor-agent"), ("antigravity", "agy"), ("omp", "omp")`.

- [ ] **Step 5: Run** `npm test`, `npx tsc --noEmit`, `cargo fmt && cargo test` — PASS.
- [ ] **Step 6: Commit** `git commit -m "feat(roster): add Gemini, Cursor, Antigravity and OMP templates (L0)"`.

### Task 10: Gemini manifest

- [ ] **Step 1: Fixture tests (failing first):**

```ts
describe('gemini manifest', () => {
  it('apply/allow confirmation boxes are blocked', () => {
    expect(evaluateManifest(geminiManifest, input('│ Apply this change?')).state).toBe('blocked')
    expect(evaluateManifest(geminiManifest, input('│ Allow execution of: ls')).state).toBe('blocked')
    const proceed = 'Do you want to proceed?\n❯ Yes, allow once'
    expect(evaluateManifest(geminiManifest, input(proceed)).state).toBe('blocked')
  })
  it('esc-to-cancel means working', () => {
    expect(evaluateManifest(geminiManifest, input('Generating… esc to cancel')).state).toBe('working')
  })
  it('a quiet screen falls back to idle', () => {
    expect(evaluateManifest(geminiManifest, input('$ ok')).state).toBe('idle')
  })
})
```

- [ ] **Step 2–3: Implement gemini.ts** (port of `gemini.toml` 2026.06.10.1):

```ts
export const geminiManifest: Manifest = {
  id: 'gemini',
  herdrVersion: '2026.06.10.1',
  rules: [
    {
      id: 'apply_or_allow_change', state: 'blocked', priority: 300,
      region: 'whole_recent', visibleBlocker: true,
      any: [
        { contains: ['│ Apply this change'] },
        { contains: ['│ Allow execution'] },
        {
          all: [
            { contains: ['yes'] },
            {
              any: [
                { contains: ['waiting for user confirmation'] },
                { contains: ['│ Do you want to proceed'] },
                { contains: ['do you want to proceed?'] }
              ]
            }
          ]
        },
        { lineRegex: [/^\s*❯.*(yes|allow)/i] }
      ]
    },
    { id: 'esc_cancel_working', state: 'working', priority: 100, region: 'whole_recent', visibleWorking: true, contains: ['esc to cancel'] }
  ]
}
```

- [ ] **Step 4–5: register, run, commit** `git commit -m "feat(roster): port gemini detection manifest from herdr (L1)"`.

### Task 11: Cursor manifest

- [ ] **Step 1: Fixture tests (failing first):**

```ts
describe('cursor manifest', () => {
  it('the write-file approval is blocked', () => {
    const screen = 'Write to this file? proceed (y)\nreject & propose changes'
    expect(evaluateManifest(cursorManifest, input(screen)).state).toBe('blocked')
  })
  it('command approval prompts are blocked', () => {
    const screen = 'Run this command?\nWaiting for approval\nrun (once) (y)'
    expect(evaluateManifest(cursorManifest, input(screen)).state).toBe('blocked')
    expect(evaluateManifest(cursorManifest, input('accept (y) (enter)')).state).toBe('blocked')
  })
  it('stop hint / background tasks / spinner mean working', () => {
    expect(evaluateManifest(cursorManifest, input('ctrl+c to stop')).state).toBe('working')
    expect(evaluateManifest(cursorManifest, input('2 background tasks')).state).toBe('working')
    expect(evaluateManifest(cursorManifest, input('⬢ Generating response')).state).toBe('working')
  })
  it('a quiet screen falls back to idle', () => {
    expect(evaluateManifest(cursorManifest, input('$ ok')).state).toBe('idle')
  })
})
```

- [ ] **Step 2–3: Implement cursor.ts** (port of `cursor.toml` 2026.08.03.1):

```ts
export const cursorManifest: Manifest = {
  id: 'cursor',
  herdrVersion: '2026.08.03.1',
  rules: [
    {
      id: 'write_file_approval', state: 'blocked', priority: 320,
      region: { bottomNonEmptyLines: 8 }, visibleBlocker: true,
      contains: ['write to this file?', 'proceed (y)'],
      any: [
        { contains: ['reject & propose changes'] },
        { contains: ['esc or n or p'] },
        { contains: ['add write('] }
      ]
    },
    {
      id: 'approval_prompt', state: 'blocked', priority: 300,
      region: 'whole_recent', visibleBlocker: true,
      any: [
        {
          contains: ['waiting for approval', 'run this command?'],
          any: [{ contains: ['run (once) (y)'] }, { contains: ['skip (esc or n)'] }]
        },
        { contains: ['(y) (enter)'] },
        { lineRegex: [/^\s*allow .*\(y\)/i] },
        { contains: ['keep (n)'] },
        { contains: ['skip (esc or n)'] },
        { lineRegex: [/^\s*(?:→\s*)?run .*\(y\)/i] }
      ]
    },
    {
      id: 'stop_hint_working', state: 'working', priority: 100,
      region: { bottomNonEmptyLines: 6 }, visibleWorking: true,
      contains: ['ctrl+c to stop']
    },
    {
      id: 'background_task_status_working', state: 'working', priority: 95,
      region: { bottomNonEmptyLines: 5 }, visibleWorking: true,
      lineRegex: [/\b[1-9][0-9]*\s+background\s+tasks?\b/i]
    },
    {
      id: 'spinner_working', state: 'working', priority: 90,
      region: { bottomNonEmptyLines: 8 }, visibleWorking: true,
      lineRegex: [/^\s*(⬡|⬢|[\u{2800}-\u{28FF}]+)\s+\p{Alphabetic}+\w*ing\b/u]
    }
  ]
}
```

- [ ] **Step 4–5: register, run, commit** `git commit -m "feat(roster): port cursor detection manifest from herdr (L1)"`.

### Task 12: Antigravity manifest (keyed `antigravity`, herdr key is `agy`)

- [ ] **Step 1: Fixture tests (failing first):**

```ts
describe('antigravity manifest', () => {
  it('the permission prompt is blocked', () => {
    const screen = 'Requesting permission for: run ls\nDo you want to proceed?'
    expect(evaluateManifest(antigravityManifest, input(screen)).state).toBe('blocked')
  })
  it('spinner and background-task lines mean working', () => {
    expect(evaluateManifest(antigravityManifest, input('⣾ Analyzing repository')).state).toBe('working')
    expect(evaluateManifest(antigravityManifest, input('· 3 tasks running')).state).toBe('working')
  })
  it('a quiet screen falls back to idle', () => {
    expect(evaluateManifest(antigravityManifest, input('$ ok')).state).toBe('idle')
  })
})
```

- [ ] **Step 2–3: Implement antigravity.ts** (port of `antigravity.toml` 2026.06.24.1):

```ts
export const antigravityManifest: Manifest = {
  id: 'antigravity',
  herdrVersion: '2026.06.24.1',
  rules: [
    {
      id: 'permission_prompt', state: 'blocked', priority: 300,
      region: 'whole_recent', visibleBlocker: true,
      contains: ['requesting permission for:'],
      any: [{ contains: ['do you want to proceed?'] }, { contains: ['tab amend', 'edit command'] }]
    },
    {
      id: 'spinner_working', state: 'working', priority: 100,
      region: 'whole_recent', visibleWorking: true,
      lineRegex: [/^\s*[\u{2800}-\u{28FF}]+\s+\p{Alphabetic}+\w*ing\b/u]
    },
    {
      id: 'background_tasks_working', state: 'working', priority: 90,
      region: { bottomNonEmptyLines: 5 }, visibleWorking: true,
      lineRegex: [/·\s*[1-9][0-9]*\s+task/i]
    }
  ]
}
```

OMP deliberately gets **no manifest** (herdr is hooks-only for it): the pane keeps the legacy ActivityDot and OMP does not appear in Settings → Notifications. Extend the `manifestForAgent` test: `expect(manifestForAgent('omp')).toBeUndefined()`.

- [ ] **Step 4–5: register, run, commit** `git commit -m "feat(roster): port antigravity detection manifest from herdr (L1)"`.

### Task 13: Composer overflow guard

**Files:**
- Modify: `src/components/Welcome/Welcome.tsx` (the `AI agents` stepper block, ~line 489)

10 stepper rows can clip the 2-column dialog at common window sizes.

- [ ] **Step 1:** Wrap the stepper list in a scroll container — change `<div className="space-y-1.5">` to `<div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">` (steppers are ~28 px each; 64 = 16rem ≈ 9 rows visible, scroll for the rest; `pr-1` keeps the scrollbar off the +/− buttons).
- [ ] **Step 2:** `npx tsc --noEmit` + `npm test` — PASS (no logic change).
- [ ] **Step 3:** Visual check happens in the user's final smoke (app run) — note it in the report.
- [ ] **Step 4: Commit** `git commit -m "fix(composer): scroll the agent stepper list past nine rows"`.

---

## Wave 3 — Qwen MCP enrollment (L3)

### Task 14: Qwen settings writer

**Files:**
- Modify: `src-tauri/src/mcp/config.rs` (+ call in `src-tauri/src/mcp/mod.rs` next to `register_codex`)

Scope decision (from the spec's "start with wave-1 agents; add on demand"): only **qwen** ships now — it is the only new CLI installed on this machine, so it is the only writer we can verify. Copilot/Amp enrollment waits for a machine with those CLIs; the MembersTab manual hint remains the universal fallback.

- [ ] **Step 1: Research gate.** Qwen Code is a Gemini CLI fork; MCP servers live in `$QWEN_HOME||~/.qwen/settings.json` under `mcpServers`. Confirm with the installed CLI (`qwen mcp add --help`, `qwen mcp list`) and its docs: (a) the HTTP transport key (`httpUrl`) and `headers` support; (b) whether settings strings expand `$VAR`/`${VAR}` from the environment. **Decision:** expansion supported → Claude-style placeholder entry written once (`"httpUrl": "${SWARMTERM_MCP_URL}"`, `"headers": {"Authorization": "Bearer ${SWARMTERM_SESSION}"}`). Expansion NOT supported → STOP: a concrete bearer cannot serve multiple panes from one shared file; skip enrollment with an `eprintln!` note and report it.
- [ ] **Step 2: Failing tests** in `config.rs` mirroring the claude writer's suite: creates-from-nothing, preserves foreign `mcpServers` keys and unrelated top-level keys, replaces a stale swarmterm block, errors on malformed JSON (file left untouched), idempotent skip-if-current, `resolve_qwen_settings_path` honors `QWEN_HOME` and ignores blank.
- [ ] **Step 3: Implement** `merge_qwen_settings` / `write_qwen_settings_to_file` / `resolve_qwen_settings_path` / `register_qwen(app)` following the existing claude-writer shape (serde_json, tmp+rename via `path.with_extension("json.tmp")`, skip-if-current); call `register_qwen` from `mcp/mod.rs` beside `register_codex`. Rules carried over: merge, never clobber foreign keys; atomic tmp+rename; log-only failure.
- [ ] **Step 4: Verify** `cargo fmt && cargo test`, plus a manual `qwen mcp list` against a settings.json produced by the writer (in `$QWEN_HOME` pointed at a temp dir) showing the swarmterm entry parses.
- [ ] **Step 5: Commit** `git commit -m "feat(mcp): auto-enroll qwen via settings.json placeholder entry (L3)"`.

---

## Wrap-up

### Task 15: Docs + full verification

**Files:**
- Modify: `docs/user-guide.md` (agent list + War Room section), `docs/manual-smoke-tests.md` (one row per new agent), `THIRD-PARTY-NOTICES.md` (only if it enumerates specific herdr-derived files), `BACKLOG.md` (status; local, not committed)

- [ ] **Step 1:** User guide: extend the agents list with the 7 new CLIs, note per-agent support level (state dot for all but OMP; resume for qwen; MCP auto-enroll claude/codex/qwen — others via the War Room manual hint), and the OMP limitation (activity dot only).
- [ ] **Step 2:** Manual smoke checklist: add a row per agent — spawn from composer, state dot transitions, War Room execute round-trip, resume (qwen), MCP tool call (qwen).
- [ ] **Step 3:** Check `THIRD-PARTY-NOTICES.md` — if the herdr entry is path-scoped to `src/lib/agent-state/`, nothing to do; if it lists files, append the new manifests.
- [ ] **Step 4:** Full gate: `npm test` && `npx tsc --noEmit` && (cd src-tauri && cargo fmt --check && cargo test). Paste outputs in the report.
- [ ] **Step 5: Commit docs** `git commit -m "docs: agent roster expansion — user guide + smoke checklist"`.
- [ ] **Step 6:** Update `BACKLOG.md` (uncommitted) and the memory file for the project status.

## Deferred (explicitly out of this plan)

- Copilot/Amp/Gemini/Cursor/Antigravity/OMP session scanners (stores unverifiable on this machine; resume rules are dormant until scanners land).
- Copilot/Amp MCP enrollment writers (CLIs not installed here — unverifiable).
- The Copilot focus-gained/synthetic-Enter quirk (spec: only if the War Room execute smoke reproduces it — copilot not installed).
- OMP hand-authored L1 manifest attempt (needs a real OMP session to verify; spec allows L0 + documented limit).
- Per-agent manual smokes for CLIs not installed on this machine.
