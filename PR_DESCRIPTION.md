## What & why

### Problem
By default, xterm 6 maps every `Enter` keydown to Carriage Return (`CR` / `\r`) regardless of whether `Shift` is held. Consequently, terminal agent composers (such as Claude Code or Codex prompt) immediately submit the prompt instead of inserting a line break, making multi-line drafting cumbersome.

### Solution
- **Shift+Enter detection:** Added pure helper `isSoftLineBreakKey` (`terminal-input-client.ts`) to capture exact `Shift+Enter` keydown chords while ignoring keypress/keyup, IME composition, and mixed modifier combinations.
- **Terminal registry interception:** Used `attachCustomKeyEventHandler` in `terminal-registry.ts` to intercept the chord, prevent default xterm handling, and emit Line Feed (`\n`) via `sendInput` (supporting broadcast panes seamlessly).
- **Hold War Room delivery:** Updated `terminal-typing-store.ts` to treat `Shift+Enter` as an `edit` semantic rather than `submit`, keeping `dirty: true` so multi-line drafts do not trigger unintended early delivery.
- **UI & Documentation:**
  - Registered shortcut in the Keybindings modal (`Shift+Enter: Insert line break`).
  - Added user guide documentation in `docs/user-guide.md` and manual verification cases in `docs/manual-smoke-tests.md`.
  - Accompanied by full unit test coverage across `terminal-input-client`, `terminal-typing-store`, and `keybindings`.

## Checklist

- [x] `npm test` and `npx tsc --noEmit` pass
- [x] `cargo test`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` pass (no `src-tauri/` changes)
- [x] New logic in `src/lib/` has tests beside it
- [x] Walked the relevant [manual smoke tests](docs/manual-smoke-tests.md) for pty/focus/War Room/worktree changes
- [x] I agree to the license terms in [CONTRIBUTING.md](CONTRIBUTING.md#license-and-contributor-agreement)
