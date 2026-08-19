import { describe, expect, it } from 'vitest'
import { evaluateManifest } from '@/lib/agent-state/engine'
import { claudeCodeManifest } from '@/lib/agent-state/manifests/claude-code'
import { codexManifest } from '@/lib/agent-state/manifests/codex'
import { opencodeManifest } from '@/lib/agent-state/manifests/opencode'
import { ampManifest } from '@/lib/agent-state/manifests/amp'
import { antigravityManifest } from '@/lib/agent-state/manifests/antigravity'
import { copilotManifest } from '@/lib/agent-state/manifests/copilot'
import { cursorManifest } from '@/lib/agent-state/manifests/cursor'
import { geminiManifest } from '@/lib/agent-state/manifests/gemini'
import { qwenManifest } from '@/lib/agent-state/manifests/qwen'
import { manifestForAgent } from '@/lib/agent-state/manifests'

const input = (screen: string, oscTitle = '', oscProgress = ''): Parameters<typeof evaluateManifest>[1] => ({
  screen,
  oscTitle,
  oscProgress
})

describe('manifestForAgent', () => {
  it('maps agent template ids and refuses plain terminals', () => {
    expect(manifestForAgent('claude-code')?.id).toBe('claude-code')
    expect(manifestForAgent('codex')?.id).toBe('codex')
    expect(manifestForAgent('opencode')?.id).toBe('opencode')
    expect(manifestForAgent('terminal')).toBeUndefined()
    expect(manifestForAgent(undefined)).toBeUndefined()
  })
  it('omp has no manifest by design (herdr is hooks-only for it)', () => {
    // The pane keeps the legacy ActivityDot and omp stays out of
    // Settings → Notifications, whose rows derive from manifest presence.
    expect(manifestForAgent('omp')).toBeUndefined()
  })
})

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

describe('claude-code manifest', () => {
  it('braille or half-circle spinner in the OSC title means working', () => {
    expect(evaluateManifest(claudeCodeManifest, input('anything', '⠹ Reticulating…')).state).toBe('working')
    expect(evaluateManifest(claudeCodeManifest, input('anything', '◐ Thinking…')).state).toBe('working')
  })
  it('✳ in the OSC title means idle', () => {
    const v = evaluateManifest(claudeCodeManifest, input('anything', '✳ Ready'))
    expect(v.state).toBe('idle')
    expect(v.visibleIdle).toBe(true)
  })
  it('a bash permission prompt is blocked', () => {
    const screen = [
      'Bash command',
      '',
      '  rm -rf node_modules',
      '',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No, and tell Claude what to do differently (esc)'
    ].join('\n')
    const v = evaluateManifest(claudeCodeManifest, input(screen))
    expect(v.state).toBe('blocked')
    expect(v.visibleBlocker).toBe(true)
  })
  it('a confirm form after the last rule is blocked', () => {
    const screen = ['───', 'Create file src/foo.ts?', '', 'enter to confirm · esc to cancel'].join('\n')
    expect(evaluateManifest(claudeCodeManifest, input(screen)).state).toBe('blocked')
  })
  it('the ❯ prompt box is PROVEN idle; a menu open inside it only falls back to idle', () => {
    const idleScreen = ['some output', '───', ' ❯ ', '───'].join('\n')
    const idle = evaluateManifest(claudeCodeManifest, input(idleScreen))
    expect(idle.state).toBe('idle')
    expect(idle.visibleIdle).toBe(true)
    // A menu inside the box trips the rule's not-gates, so nothing matches and
    // the verdict is the idle FALLBACK (visibleIdle=false) — herdr semantics:
    // the debounce treats proven idle and fallback idle differently.
    const menu = evaluateManifest(claudeCodeManifest, input(menuScreen()))
    expect(menu.visibleIdle).toBe(false)

    function menuScreen(): string {
      return ['some output', '───', ' ❯ pick one — enter to select · tab/arrow keys to navigate', '───'].join('\n')
    }
  })
  it('the transcript viewer freezes state (skip)', () => {
    const screen = ['big transcript', 'Showing detailed transcript', 'ctrl+o to toggle · ↑↓ scroll'].join('\n')
    expect(evaluateManifest(claudeCodeManifest, input(screen)).skip).toBe(true)
  })
  it('OSC 9 progress cleared (4;0) reads idle', () => {
    expect(evaluateManifest(claudeCodeManifest, input('anything', '', '4;0')).state).toBe('idle')
  })
})

describe('codex manifest', () => {
  it('"Action Required" title beats the working spinner title', () => {
    const v = evaluateManifest(codexManifest, input('screen', '⠙ Action Required'))
    expect(v.state).toBe('blocked')
  })
  it('braille spinner title means working', () => {
    expect(evaluateManifest(codexManifest, input('screen', '⠙ codex')).state).toBe('working')
  })
  it('a non-spinner title means idle', () => {
    const v = evaluateManifest(codexManifest, input('screen', 'codex — ready'))
    expect(v.state).toBe('idle')
    expect(v.visibleIdle).toBe(true)
  })
  it('the trust-directory prompt is blocked', () => {
    const screen = ['> You are in /work/repo', '', 'Do you trust the contents of this directory?'].join('\n')
    expect(evaluateManifest(codexManifest, input(screen)).state).toBe('blocked')
  })
  it('a strong blocker after the › prompt marker is blocked', () => {
    const screen = ['done stuff', '› ', 'Allow command? Press enter to confirm or esc to cancel'].join('\n')
    expect(evaluateManifest(codexManifest, input(screen)).state).toBe('blocked')
  })
  it('the • Working footer means working', () => {
    const screen = ['output', '• Working (3s · esc to interrupt)'].join('\n')
    expect(evaluateManifest(codexManifest, input(screen)).state).toBe('working')
  })
  it('the transcript viewer freezes state', () => {
    const screen = ['history', '› ', '↑/↓ to scroll · pgup/pgdn to page · home/end to jump · q to quit · esc to edit prev'].join('\n')
    expect(evaluateManifest(codexManifest, input(screen)).skip).toBe(true)
  })
})

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
    // Both line_regex needles must hit (AND): the numbered option AND the
    // ↑/↓ … Enter … help footer the dialog always renders beneath it.
    const screen = '❯ 1. Yes, proceed\n↑/↓ : navigate · Enter : select'
    expect(evaluateManifest(qwenManifest, input(screen)).state).toBe('blocked')
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

describe('opencode manifest', () => {
  it('△ Permission required is blocked', () => {
    const v = evaluateManifest(opencodeManifest, input('stuff\n△ Permission required'))
    expect(v.state).toBe('blocked')
    expect(v.visibleBlocker).toBe(true)
  })
  it('the dialog footer variant is blocked', () => {
    const screen = 'question\n↑↓ select · enter confirm · esc dismiss'
    expect(evaluateManifest(opencodeManifest, input(screen)).state).toBe('blocked')
  })
  it('esc-to-interrupt hint means working', () => {
    expect(evaluateManifest(opencodeManifest, input('thinking… esc to interrupt')).state).toBe('working')
  })
  it('a progress bar run means working', () => {
    expect(evaluateManifest(opencodeManifest, input('■■■■■□□')).state).toBe('working')
  })
  it('a quiet screen falls back to idle', () => {
    expect(evaluateManifest(opencodeManifest, input('$ ready')).state).toBe('idle')
  })
})
