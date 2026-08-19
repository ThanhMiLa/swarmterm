/**
 * Detection rules for GitHub Copilot CLI, ported to TypeScript from herdr's
 * src/detect/manifests/github-copilot.toml (manifest version 2026.07.07.1).
 * herdr is licensed under the Apache License 2.0; this derived file is
 * modified from the original. See THIRD-PARTY-NOTICES.md at the repo root.
 *
 * Copilot's TUI exposes no OSC-title signals, so both rules read the recent
 * screen: a selection dialog (esc + enter hints together) blocks, a lone
 * esc-cancel hint means working.
 */
import type { Manifest } from '@/lib/agent-state/types'

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
